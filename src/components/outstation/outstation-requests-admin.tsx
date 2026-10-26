"use client";

import {
  CalendarDays,
  Calculator,
  Camera,
  CheckCircle2,
  Clock,
  Download,
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
import { createPortal } from "react-dom";

import { AdminManagerExpenseModal } from "@/components/outstation/admin-manager-expense-modal";
import { OutstationDescription } from "@/components/outstation/outstation-description";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import {
  CostBreakdownFact,
  Fact,
  RouteFact,
} from "@/components/outstation/approval-detail-primitives";
import { HeldRequestsPanel } from "@/components/outstation/held-requests-panel";
import { OutstationReviewMap } from "@/components/outstation/outstation-review-map";
import { TerritoryValidationPanel } from "@/components/outstation/territory-validation-panel";
import { TripEvidencePhotos } from "@/components/outstation/trip-evidence-photos";
import { TripWorkloadEvidencePanel } from "@/components/outstation/trip-workload-evidence";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { Input } from "@/components/ui/input";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import { countOf, formatDateTimeValue, formatDateValue } from "@/lib/i18n/format";
import { resolveCaptureTimeliness } from "@/lib/outstation/capture-timeliness";
import { OUTSTATION_CLAIM_CHANGED_CODE } from "@/lib/outstation/claim-revision";
import { viewEligibilityReason } from "@/lib/outstation/eligibility-reason";
import { approverTripPhotos } from "@/lib/outstation/trip-evidence-photos";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";
import { formatEmployeeDisplayName } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import {
  PortalRecordCard,
  PortalRecordFields,
} from "@/components/employee-portal/portal-primitives";


type AdminAction = "approve" | "delete" | "fill-distance" | "reject";

type ActionPayload = {
  error?: string;
  linkedPayroll?: {
    deletedRows?: number;
    expenseTripId?: string;
  };
  message?: string;
  request?: OutstationExpenseRequest;
};

function formatCurrency(value: number) {
  return stableCurrencyFormatter("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

// All three used to call toLocaleDateString()/toLocaleString() with NO timeZone, so they
// rendered in whatever zone the viewer's machine happened to be in — Cairo only by accident,
// and UTC on any server-rendered pass. Phoenix reports every time in Africa/Cairo; the shared
// formatters below pin it. The compact shape ("17 Oct 2026") is kept deliberately: the long
// "Tuesday, 17 October 2026" form the owner asked for is for EMAILS, and would wrap inside
// these dense grid cells, which the no-wrap rule forbids.
function formatDate(value: string) {
  return formatDateValue(value) || "N/A";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "N/A";
  return formatDateTimeValue(value) || "N/A";
}

function formatKm(value: number | null | undefined) {
  // Never "N/A" and never 0: a missing distance means the Google route lookup failed, and
  // that is a different fact from a measured zero-kilometre trip.
  if (value == null || !Number.isFinite(value)) return "Route lookup failed";
  return `${value.toFixed(2)} KM`;
}

function formatStatus(value: string) {
  return value.replace(/_/g, " ");
}

// Trip month key as "YYYY-MM" from an ISO-ish date string (used for the month filter).
function tripMonthKey(value: string | null | undefined) {
  if (!value) return "";
  const key = String(value).slice(0, 7);
  return /^\d{4}-\d{2}$/.test(key) ? key : "";
}

function formatMonthLabel(key: string) {
  const [year, month] = key.split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(date.getTime())) return key;
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// Round numeric export cells to 2 dp so the styled XLSX SUM() totals stay clean.
function roundForExport(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 0;
  return Number(value.toFixed(2));
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
  return "bg-phx-accent-soft text-phx-accent-press ring-[#FED7AA]";
}

function requestStatusTone(status: string) {
  const normalized = status.toLowerCase();
  if (normalized.includes("accept") || normalized === "approved") return "bg-[#ECFDF5] text-[#047857] ring-[#A7F3D0]";
  if (normalized.includes("reject") || normalized === "rejected") return "bg-[#FEF2F2] text-[#B91C1C] ring-[#FECACA]";
  return "bg-phx-accent-soft text-phx-accent-press ring-[#FED7AA]";
}

function recommendationTone(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "auto_approve") return "text-[#047857]";
  if (normalized === "hr_review" || normalized === "finance_review") return "text-[#1D4ED8]";
  if (normalized === "reject") return "text-[#B91C1C]";
  return "text-phx-accent-press";
}

const panelClassName =
  "rounded-lg border border-phx-line bg-white/94 shadow-[0_1px_3px_rgba(15,23,42,0.06)] backdrop-blur";
const adminTableHeaderClassName = "px-4 py-3 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";
const stickyEmployeeHeaderClassName = `${adminTableHeaderClassName} sticky left-0 z-30 w-[260px] min-w-[260px] bg-phx-paper shadow-[10px_0_18px_rgba(15,23,42,0.06)]`;
const stickyTripHeaderClassName = `${adminTableHeaderClassName} sticky left-[260px] z-30 w-[220px] min-w-[220px] bg-phx-paper shadow-[10px_0_18px_rgba(15,23,42,0.04)]`;
const stickyEmployeeCellClassName = "sticky left-0 z-20 w-[260px] min-w-[260px] px-4 py-3 shadow-[10px_0_18px_rgba(15,23,42,0.05)]";
const stickyTripCellClassName = "sticky left-[260px] z-20 w-[220px] min-w-[220px] px-4 py-3 shadow-[10px_0_18px_rgba(15,23,42,0.04)]";


function OutstationAdminShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate min-h-[calc(100vh-8rem)] overflow-hidden rounded-lg border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_32%),linear-gradient(135deg,#FFF9F3_0%,#FFFFFF_44%,#F7FAFC_100%)] p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-phx-accent/12 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-10 left-1/4 h-64 w-64 rounded-full bg-phx-ink/6 blur-3xl"
      />
      <div className="relative z-10 space-y-6">{children}</div>
    </div>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <Card className={`${panelClassName} p-4 transition-transform duration-200 hover:-translate-y-0.5`}>
      <p className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">{label}</p>
      <p className="mt-2 truncate text-lg font-black text-phx-ink">{value}</p>
    </Card>
  );
}

function RequestActionButtons({
  actionMessage,
  acting,
  actionError,
  actionRequestId,
  canApprove,
  onApprove,
  onDelete,
  onReject,
  request,
}: {
  actionError: string | null;
  actionMessage: string | null;
  acting: { action: AdminAction; id: number } | null;
  actionRequestId: number | null;
  canApprove: boolean;
  onApprove: (request: OutstationExpenseRequest) => void;
  onDelete: (request: OutstationExpenseRequest) => void;
  onReject: (request: OutstationExpenseRequest) => void;
  request: OutstationExpenseRequest;
}) {
  const busy = acting?.id === request.id;
  // Show the outcome once the action has SETTLED, which is exactly when `busy` goes false.
  const settled = !busy && actionRequestId === request.id;
  const approving = busy && acting?.action === "approve";
  const deleting = busy && acting?.action === "delete";
  const rejecting = busy && acting?.action === "reject";
  // Super-Admin override: a system-rejected request can still be accepted, and an
  // accepted one can still be rejected — only disable the action that matches the
  // current decision.
  const isAccepted = request.status.includes("accept");
  const isRejected = request.status.includes("reject");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="gap-2 rounded-xl bg-[#047857] px-4 py-2 text-xs font-black text-white hover:bg-[#065F46]"
          disabled={!canApprove || busy || isAccepted}
          onClick={() => onApprove(request)}
          type="button"
        >
          {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Accept for payroll
        </Button>
        <Button
          className="gap-2 rounded-xl bg-[#B91C1C] px-4 py-2 text-xs font-black text-white hover:bg-[#991B1B]"
          disabled={!canApprove || busy || isRejected}
          onClick={() => onReject(request)}
          type="button"
        >
          {rejecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
          Reject
        </Button>
        <Button
          className="gap-2 rounded-xl border border-[#FECACA] bg-white px-4 py-2 text-xs font-black text-[#B91C1C] hover:bg-[#FEF2F2]"
          disabled={!canApprove || busy}
          onClick={() => onDelete(request)}
          title="Delete this expense if it has not been imported into a payroll batch."
          type="button"
        >
          {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          Delete expense
        </Button>
      </div>
      {isAccepted ? (
        <p className="text-xs font-black uppercase tracking-[0.12em] text-[#047857]">Accepted - payroll import lock checked before delete</p>
      ) : null}
      {request.status.includes("reject") ? (
        <p className="text-xs font-black uppercase tracking-[0.12em] text-[#B91C1C]">Rejected by admin review</p>
      ) : null}
      {actionMessage && settled ? <p className="text-sm font-semibold text-[#047857]">{actionMessage}</p> : null}
      {actionError && settled ? (
        <p role="alert" className="text-sm font-semibold text-[#B91C1C]">{actionError}</p>
      ) : null}
    </div>
  );
}

function RequestDetailsModal({
  actionError,
  actionMessage,
  acting,
  actionRequestId,
  canApprove,
  onApprove,
  onClose,
  onDelete,
  onReject,
  request,
}: {
  actionError: string | null;
  actionMessage: string | null;
  acting: { action: AdminAction; id: number } | null;
  actionRequestId: number | null;
  canApprove: boolean;
  onApprove: (request: OutstationExpenseRequest) => void;
  onClose: () => void;
  onDelete: (request: OutstationExpenseRequest) => void;
  onReject: (request: OutstationExpenseRequest) => void;
  request: OutstationExpenseRequest;
}) {
  // Render through a portal to document.body so the dialog escapes the admin
  // shell's stacking context and is never painted under the sticky topbar.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);
  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-[#020617]/65 p-3 backdrop-blur-sm sm:p-6">
      <div className="w-full max-w-4xl overflow-hidden rounded-none border border-phx-line bg-white shadow-[0_28px_90px_rgba(15,23,42,0.3)]">
        {/* Owner request (2026-08-04): a held request must read EXACTLY as the Expense Approval
            detail. This is that screen's header — dark bar, eyebrow, name, HR ID / id, status
            badge — and the fact grid below it is its fact grid. The shared pieces come from
            approval-detail-primitives so the two cannot drift apart. */}
        <div className="sticky top-0 z-10 flex flex-wrap items-start justify-between gap-3 bg-slate-900 px-5 py-4">
          <div className="min-w-0">
            <p className="text-phx-2xs font-black uppercase tracking-[0.22em] text-orange-400">Trip under review</p>
            <h2 className="mt-1 text-lg font-black tracking-tight text-white">
              {formatEmployeeDisplayName(request.employeeName) || "Unassigned"}
            </h2>
            <p className="mt-0.5 font-mono text-xs text-slate-400">
              {request.employeeHrId || "HR ID not mapped"} · OUTSTATION-{request.id} · {request.employeeRole}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <span className={`inline-flex rounded-none px-3 py-1 text-xs font-bold ring-1 ${requestStatusTone(request.status)}`}>
              {formatStatus(request.status)}
            </span>
            {/* A plain GET link, never a button with a handler: the PDF is a second RENDERING of this
                same review, read by the same gate, and downloading it changes nothing. */}
            <a
              className="inline-flex items-center gap-1.5 rounded-none border border-orange-400/60 bg-orange-500/10 px-3 py-2 text-xs font-black text-orange-200 hover:bg-orange-500/20"
              download
              href={`/api/admin/outstation/${request.id}/pdf`}
            >
              <Download aria-hidden className="h-3.5 w-3.5" />
              Download PDF
            </a>
            <button
              className="rounded-none border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-black text-slate-200 hover:bg-slate-700"
              onClick={onClose}
              type="button"
            >
              Close
            </button>
          </div>
        </div>

        <div className="space-y-5 p-5">
          {/* Above the facts, not below them: the captured coordinate is what Distance, Captured
              location, Captured brick and Location match are all derived from, so a reviewer has
              to know it may belong to a different day BEFORE reading any of them. Flags only —
              never a refusal, never an input to the decision (capture-timeliness.ts says why). */}
          {(() => {
            const capture = resolveCaptureTimeliness({
              capturedAt: request.capturedAt,
              tripEndDate: request.tripEndDate,
            });
            if (capture.verdict !== 'late' || !capture.headline) return null;
            return (
              <div className="flex items-start gap-2 rounded-none border border-amber-300 bg-amber-50 p-3">
                <Clock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="min-w-0">
                  <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-amber-700">
                    Location captured after the trip ended
                  </p>
                  <p className="mt-1 text-xs font-semibold leading-relaxed text-amber-900">
                    {capture.headline}
                  </p>
                </div>
              </div>
            );
          })()}
          {/* The Expense Approval's fact grid, same columns and same components. The
              request-only facts (captured geography, GPS accuracy, workload provenance) live in
              it too — that screen puts facts here, and these are facts. */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Fact label="Expense type" value={formatStatus(request.expenseType)} />
            <Fact label="Trip" value={request.sameDayTrip ? "Same-day" : `${request.overnightDays} night(s)`} />
            <Fact label="Start" value={formatDate(request.tripStartDate)} />
            <Fact label="End" value={formatDate(request.tripEndDate)} />
            <Fact label="Transport" value={formatStatus(request.transportationType)} />
            <Fact label="Distance" value={formatKm(request.distanceFromResidenceKm)} />
            <Fact label="Submitted" value={formatDateTime(request.submittedAt ?? request.createdAt)} />
            <Fact label="Captured time" value={formatDateTime(request.capturedAt)} />
            <Fact
              label="GPS accuracy"
              value={
                request.capturedAccuracyMeters === null
                  ? "Not reported"
                  : `${request.capturedAccuracyMeters.toFixed(0)} m`
              }
            />
            <Fact label="Offline capture" value={request.offlineCaptured ? "Yes" : "No"} />
            {/* Owner request (2026-08-04): the place, not the coordinate pair. Brick and
                area/region derive from the same captured point (captured-location.ts); the match
                confidence rides along because a nearest-brick match is an approximation and must
                never read as an exact one. */}
            <Fact label="Captured location" value={request.capturedLocation?.label ?? "Not resolved"} />
            <Fact label="Captured brick" value={request.capturedLocation?.brickLabel ?? "Not resolved"} />
            <Fact
              label="Captured area / region"
              value={
                request.capturedLocation
                  ? `${request.capturedLocation.areaLabel} · ${request.capturedLocation.regionLabel}`
                  : "Not resolved"
              }
            />
            <Fact label="Location match" value={request.capturedLocation?.confidence ?? "Not matched"} />
            <Fact label="AM visits" value={String(request.amWorkload ?? 0)} />
            <Fact label="PM visits" value={String(request.pmWorkload ?? 0)} />
            {/* AM · PM · Pharmacies. NULL: stamped before the split or typed by hand, so its
                pharmacy visits sit inside AM/PM — said in words, never shown as 0. */}
            <Fact
              label="Pharmacy visits"
              value={
                request.pharmacyWorkload === null || request.pharmacyWorkload === undefined
                  ? "Not counted separately"
                  : String(request.pharmacyWorkload)
              }
            />
            <Fact label="Workload source" value={formatStatus(request.workloadSource ?? "manual")} />
            {/* Dated on purpose. This verdict is stamped once, when the request is SUBMITTED —
                the one moment the CRM is guaranteed to be emptiest, because visits are entered
                through and after the trip and the mirror syncs after that. Nothing re-reads it.
                Undated it reads as the current state of the world, and for 18 of 26 "no activity"
                requests measured on production it was already contradicted by the CRM. The panel
                below holds the live read and names the disagreement outright. */}
            <Fact
              label="Workload match (at submission)"
              value={formatStatus(request.workloadMatchStatus ?? "manual")}
            />
            <RouteFact
              from={[request.residenceAddress, request.residenceArea, request.residenceCity].filter(Boolean).join(", ") || "Residence"}
              to={request.toLabel ?? request.toCity ?? request.toArea ?? "—"}
            />
            <CostBreakdownFact
              allowance={request.allowanceAmount}
              formatCurrency={formatCurrency}
              meeting={request.meetingAmount ?? 0}
              other={request.otherAmount ?? 0}
              total={request.claimedTotalAmount || request.expectedTotalAmount}
              travel={request.reportTravelCost ?? request.fuelAmount + request.ticketAmount}
            />
          </div>

          {/* First in the body, exactly as on the Expense Approval: the verified CRM workload
              with its per-day breakdown. The flat "AM visits / PM visits" numbers in the grid
              above are the DECLARED figures; this is the evidence behind them, and it is what
              the approver actually decides on. */}
          <TripWorkloadEvidencePanel
            declaredAm={request.amWorkload ?? 0}
            declaredPharmacies={request.pharmacyWorkload ?? null}
            declaredPm={request.pmWorkload ?? 0}
            hrId={request.employeeHrId ?? null}
            storedMatchedAt={request.workloadMatchedAt ?? null}
            storedMatchStatus={request.workloadMatchStatus ?? null}
            tripEndDate={request.tripEndDate}
            tripStartDate={request.tripStartDate}
          />

          <Card className={`${panelClassName} p-5`}>
            <div className="mb-4 flex items-start gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-md bg-phx-accent-soft text-phx-accent-hover">
                <Calculator className="h-5 w-5" />
              </span>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.16em] text-phx-accent-hover">Allowance calculation</p>
                <h3 className="mt-1 text-lg font-black text-phx-ink">How fuel &amp; allowance are calculated</h3>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-phx-line bg-phx-paper px-4 py-3">
                <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">Fuel (round trip)</p>
                <p className="mt-1 text-lg font-black text-phx-ink">{formatCurrency(request.fuelAmount)}</p>
                <p className="mt-0.5 text-phx-xs text-phx-ink-faint">
                  {formatKm(request.distanceFromResidenceKm)} &times; 2 &middot; {formatStatus(request.transportationType)}
                </p>
              </div>
              <div className="rounded-md border border-phx-line bg-phx-paper px-4 py-3">
                <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">Allowance</p>
                <p className="mt-1 text-lg font-black text-phx-ink">{formatCurrency(request.allowanceAmount)}</p>
                <p className="mt-0.5 text-phx-xs text-phx-ink-faint">
                  {request.sameDayTrip
                    ? "Same-day trip"
                    : `${request.overnightDays} overnight ${request.overnightDays === 1 ? "night" : "nights"} + return day`}
                </p>
              </div>
            </div>
            {request.allowanceBreakdown && request.allowanceBreakdown.rows.length > 0 ? (
              <div className="mt-4 overflow-hidden rounded-md border border-phx-line">
                {request.allowanceBreakdown.rows.map((row, index) => (
                  <div
                    className="flex items-center justify-between border-b border-phx-line px-4 py-2.5 text-sm last:border-b-0"
                    key={`${row.type}-${index}`}
                  >
                    <span className="font-semibold text-phx-ink-2">{row.label}</span>
                    <span className="font-black text-phx-ink">{formatCurrency(row.amount)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </Card>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <Card className={`${panelClassName} p-5`}>
              <div className="mb-4 flex items-start gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-md bg-phx-accent-soft text-phx-accent-hover">
                  <Camera className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-phx-accent-hover">Evidence</p>
                  <h3 className="mt-1 text-lg font-black text-phx-ink">Photos and attachments</h3>
                </div>
              </div>

              {/* Both photos, arrival and departure, with each one's time and place and the departure
                  review. This panel showed the arrival photo alone until 2026-09-18: the departure
                  path was never signed, so the Super Admin, the one approver, never saw it. */}
              <TripEvidencePhotos
                photos={approverTripPhotos(request)}
                subject={formatEmployeeDisplayName(request.employeeName) || null}
              />

              <div className="mt-5 rounded-[18px] border border-phx-line bg-phx-paper/85 p-4">
                <p className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">Ticket attachments</p>
                {request.ticketAttachmentMetadata.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {request.ticketAttachmentMetadata.map((attachment, index) => {
                      // Each row is now a real link. It used to be a bare <div> styled like a
                      // card with a file icon — it read as clickable and did nothing, which is
                      // the "ticket attachment doesn't open" report. A row whose URL could not
                      // be signed says so instead of silently staying dead.
                      const url = request.ticketAttachmentUrls?.[index] ?? null;
                      const body = (
                        <>
                          <div className="min-w-0">
                            <p className="truncate font-bold text-phx-ink">{attachment.name}</p>
                            <p className="text-xs text-phx-ink-soft">{attachment.contentType} - {(attachment.size / 1024).toFixed(1)} KB</p>
                          </div>
                          {url ? (
                            <ExternalLink className="h-4 w-4 shrink-0 text-phx-accent-hover" />
                          ) : (
                            <FileText className="h-4 w-4 shrink-0 text-phx-ink-faint" />
                          )}
                        </>
                      );

                      return url ? (
                        <a
                          className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 text-sm transition-colors hover:bg-phx-accent-soft"
                          href={url}
                          key={attachment.path}
                          rel="noopener noreferrer"
                          target="_blank"
                          title={`${attachment.name} — open in a new tab`}
                        >
                          {body}
                        </a>
                      ) : (
                        <div
                          className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 text-sm"
                          key={attachment.path}
                          title="This attachment could not be signed for viewing."
                        >
                          {body}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="mt-2 text-sm font-semibold text-phx-ink-soft">No ticket attachments were uploaded.</p>
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
            {(() => {
              // The stored reason as a sentence — never the raw Google JSON rows written before
              // 2026-09-28 carry — and, separately, what has been measured since. Never a new verdict.
              const eligibility = viewEligibilityReason({
                distanceKm: request.distanceFromResidenceKm,
                minimumKm: request.minimumRequiredDistanceKm,
                reason: request.eligibilityReason,
              });
              return (
                <div className="grid gap-5 md:grid-cols-2">
                  <div className="flex min-w-0 items-start gap-3">
                    <CalendarDays aria-hidden className="mt-1 h-5 w-5 shrink-0 text-phx-accent-hover" />
                    <div className="min-w-0">
                      <p className="text-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">Eligibility</p>
                      <p className="mt-1 break-words text-sm font-semibold text-phx-ink">
                        {formatStatus(request.eligibilityStatus)}
                        {eligibility.recorded ? ` — ${eligibility.recorded}` : ""}
                      </p>
                      {eligibility.since ? (
                        <p className="mt-2 break-words border-l-2 border-sky-400 bg-sky-50 px-2.5 py-1.5 text-xs font-semibold leading-snug text-sky-900">
                          {eligibility.since}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex min-w-0 items-start gap-3">
                    <Clock aria-hidden className="mt-1 h-5 w-5 shrink-0 text-phx-accent-hover" />
                    <div className="min-w-0">
                      <p className="text-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">Approval reason</p>
                      <p className="mt-1 break-words text-sm font-semibold text-phx-ink">{request.approvalReason || "—"}</p>
                    </div>
                  </div>
                  {/* Full width: the notes now carry photo cards, not a line of machine text. */}
                  <div className="flex min-w-0 items-start gap-3 md:col-span-2">
                    <MapPinned aria-hidden className="mt-1 h-5 w-5 shrink-0 text-phx-accent-hover" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">Notes</p>
                      {/* Through the ONE formatter every other screen, email and export already
                          uses: the rep's own words, each allowance reason once with its day count,
                          and each photo stamp as a card in Cairo time — never the stored audit line
                          with its UTC timestamp, raw GPS and draft id. Each note line keeps its own
                          dir="auto" inside, so an Arabic first line cannot flip the rest. */}
                      <OutstationDescription className="mt-1 text-sm" empty="No notes" value={request.notes} />
                    </div>
                  </div>
                </div>
              );
            })()}
          </Card>
        </div>
        <div className="sticky bottom-0 z-10 border-t border-phx-line bg-white/98 px-5 py-4 backdrop-blur">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">Admin decision</p>
              <p className="mt-1 text-sm font-semibold text-phx-ink-2">Approve, reject, edit, or delete before the expense is added to payroll.</p>
            </div>
            <RequestActionButtons
              actionError={actionError}
              actionMessage={actionMessage}
              acting={acting}
              actionRequestId={actionRequestId}
              canApprove={canApprove}
              onApprove={onApprove}
              onDelete={onDelete}
              onReject={onReject}
              request={request}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function OutstationRequestsAdmin({
  canApprove,
  initialRequestId = null,
  requests,
}: {
  canApprove: boolean;
  initialRequestId?: number | null;
  requests: OutstationExpenseRequest[];
}) {
  const initialSelectedId = requests.some((request) => request.id === initialRequestId)
    ? initialRequestId
    : requests[0]?.id ?? null;
  const [localRequests, setLocalRequests] = useState(requests);
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [eligibility, setEligibility] = useState("");
  const [role, setRole] = useState("");
  const [month, setMonth] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(initialSelectedId);
  const [detailRequestId, setDetailRequestId] = useState<number | null>(
    requests.some((request) => request.id === initialRequestId) ? initialRequestId : null,
  );
  const [acting, setActing] = useState<{ action: AdminAction; id: number } | null>(null);
  // The request the last action ran on. `acting` is cleared in each action's finally block, so it
  // is already null by the time the message exists — gating the in-modal message on it rendered
  // nothing at all. This survives the clear, so the modal can say what happened.
  const [actionRequestId, setActionRequestId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [managerExpenseModal, setManagerExpenseModal] = useState<
    | { mode: "create"; targetHrId?: string; targetName?: string }
    | { mode: "edit"; request: OutstationExpenseRequest }
    | null
  >(null);

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

  useEffect(() => {
    if (searchParams.get("action") === "create-manager-expense") {
      startTransition(() => {
        setManagerExpenseModal({ mode: "create" });
      });
    }
  }, [searchParams]);

  const roles = useMemo(
    () => [...new Set(localRequests.map((request) => request.employeeRole).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [localRequests],
  );

  const months = useMemo(
    () =>
      [...new Set(localRequests.map((request) => tripMonthKey(request.tripStartDate)).filter(Boolean))].sort(
        (a, b) => b.localeCompare(a),
      ),
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
        (!role || request.employeeRole === role) &&
        (!month || tripMonthKey(request.tripStartDate) === month)
      );
    });
  }, [eligibility, localRequests, month, role, search]);

  const exportColumns = useMemo<ExportColumn[]>(
    () => [
      { key: "employee", label: "Employee", width: 26 },
      { key: "hrId", label: "HR ID", width: 12 },
      { key: "role", label: "Role", width: 22 },
      { key: "tripStart", label: "Trip start", width: 14 },
      { key: "tripEnd", label: "Trip end", width: 14 },
      { key: "destination", label: "Destination", width: 28 },
      { key: "distanceKm", label: "Distance (km)", numeric: true, width: 14 },
      { key: "eligibility", label: "Eligibility", width: 15 },
      { key: "status", label: "Status", width: 13 },
      { key: "travelCost", label: "Travel cost", numeric: true, width: 13 },
      { key: "allowance", label: "Allowance", numeric: true, width: 13 },
      { key: "meeting", label: "Meeting", numeric: true, width: 12 },
      { key: "claimed", label: "Claimed", numeric: true, width: 13 },
      { key: "recommendation", label: "Recommendation", width: 18 },
    ],
    [],
  );

  const exportRows = useMemo<ExportRow[]>(
    () =>
      filtered.map((request) => ({
        employee: formatEmployeeDisplayName(request.employeeName),
        hrId: request.employeeHrId,
        role: request.employeeRole,
        tripStart: formatDate(request.tripStartDate),
        tripEnd: formatDate(request.tripEndDate),
        destination: request.toLabel ?? request.toCity ?? request.toArea ?? "",
        distanceKm: roundForExport(request.distanceFromResidenceKm),
        eligibility: formatStatus(request.eligibilityStatus),
        status: formatStatus(request.status),
        travelCost: roundForExport(request.fuelAmount + request.ticketAmount),
        allowance: roundForExport(request.allowanceAmount),
        meeting: roundForExport(request.expenseType === "meeting" ? request.claimedTotalAmount : 0),
        claimed: roundForExport(request.claimedTotalAmount),
        recommendation: formatStatus(request.approvalRecommendation),
      })),
    [filtered],
  );

  const exportSubtitle = `Outstation expenses${month ? ` · ${formatMonthLabel(month)}` : " · all months"} · ${countOf(filtered.length, "request")}`;

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
        accumulator.approved += request.status.includes("accept") || request.status === "approved" ? 1 : 0;
        accumulator.claimed += request.claimedTotalAmount;
        accumulator.rejected += request.status.includes("reject") ? 1 : 0;
        accumulator.submitted += request.status === "submitted" ? 1 : 0;
        return accumulator;
      },
      { approved: 0, claimed: 0, rejected: 0, submitted: 0 },
    );
  }, [filtered]);

  function clearFilters() {
    setSearch("");
    setEligibility("");
    setRole("");
    setMonth("");
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
        ? `Outstation expense #${saved.id} updated.`
        : `Outstation expense #${saved.id} created for ${saved.employeeName}.`,
    );
  }

  /**
   * A decision was refused because the claim moved after this screen loaded it. Nothing was decided;
   * put the current figures on screen so the next click is on what is really there.
   */
  async function reloadRequestAfterConflict(requestId: number) {
    try {
      const response = await fetch(`/api/admin/outstation/${requestId}`, { headers: { accept: "application/json" } });
      const payload = await response.json().catch(() => null) as ActionPayload | null;
      if (response.ok && payload?.request) updateRequestInState(payload.request);
    } catch {
      // The refusal message already tells him to refresh; a failed reload must not hide it.
    }
  }

  async function approveRequest(selectedRequest: OutstationExpenseRequest) {
    setActing({ action: "approve", id: selectedRequest.id });
    setActionRequestId(selectedRequest.id);
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/admin/outstation/${selectedRequest.id}`, {
        // `expectedRevision` is the version of the claim on screen: the server refuses to approve a
        // claim that has changed since (an extra ticket, a journey stop) and pays only what was seen.
        body: JSON.stringify({
          comment: "Approved from admin outstation review.",
          expectedRevision: selectedRequest.updatedAt,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null) as ActionPayload | null;
      if (!response.ok || !payload?.request) {
        if (payload?.error === OUTSTATION_CLAIM_CHANGED_CODE) await reloadRequestAfterConflict(selectedRequest.id);
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
    setActionRequestId(request.id);
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/admin/outstation/${request.id}`, {
        body: JSON.stringify({ comment, expectedRevision: request.updatedAt }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json().catch(() => null) as ActionPayload | null;
      if (!response.ok || !payload?.request) {
        if (payload?.error === OUTSTATION_CLAIM_CHANGED_CODE) await reloadRequestAfterConflict(request.id);
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

  /**
   * Fill in a distance the original lookup never produced — and nothing else.
   *
   * Separate from Edit on purpose. Edit reprices the claim from the distance it is given (fuel is
   * distance x 2 x the rate, with ticket, travel cost and eligibility following), which is right
   * when an admin is changing a claim and wrong when a measurement is merely being recovered. The
   * route writes distance columns only, so every amount and every verdict here is untouched and the
   * decision stays exactly where it was.
   */
  async function fillDistance(request: OutstationExpenseRequest) {
    setActing({ action: "fill-distance", id: request.id });
    setActionRequestId(request.id);
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/admin/outstation/${request.id}/recalculate-distance`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => null) as
        | { distanceKm?: number; durationMinutes?: number | null; message?: string }
        | null;
      if (!response.ok || typeof payload?.distanceKm !== "number") {
        throw new Error(payload?.message ?? "Unable to recalculate the distance.");
      }
      const distanceKm = payload.distanceKm;
      const durationMinutes = payload.durationMinutes ?? null;
      setLocalRequests((current) =>
        current.map((row) =>
          row.id === request.id
            ? { ...row, distanceFromResidenceKm: distanceKm, distanceKm, durationMinutes, routeError: null }
            : row,
        ),
      );
      setActionMessage(
        `Distance filled: ${distanceKm.toFixed(2)} KM. No amount on this request was changed.`,
      );
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to recalculate the distance.",
      );
    } finally {
      setActing(null);
    }
  }

  async function deleteRequest(request: OutstationExpenseRequest) {
    const confirmed = window.confirm(
      `Delete outstation expense ${request.id}? This permanently removes the request, stored evidence files, and any linked expense row that has not been imported into payroll.`,
    );
    if (!confirmed) return;

    setActing({ action: "delete", id: request.id });
    setActionRequestId(request.id);
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
      setActionMessage(payload?.message ?? "Outstation expense deleted.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to delete outstation request.");
    } finally {
      setActing(null);
    }
  }

  const hasActiveFilters = Boolean(search || eligibility || role || month);

  if (localRequests.length === 0) {
    return (
      <OutstationAdminShell>
        <AdminPageHero
          description="No outstation expense data is currently available. You can still add a manual expense."
          eyebrow="Outstation expenses"
          icon={<ShieldAlert className="h-3.5 w-3.5" />}
          title="Residence-validated expense review"
          actions={(
            <Button
              className="gap-2 rounded-xl bg-phx-accent-hover px-4 py-2 text-xs font-black text-white hover:bg-phx-accent-press"
              onClick={() => setManagerExpenseModal({ mode: "create" })}
              type="button"
            >
              <PlusCircle className="h-4 w-4" />
              Add manual expense
            </Button>
          )}
        />
        <AdminCallout tone="neutral">
          <ShieldAlert className="mt-0.5 h-5 w-5 text-phx-accent-hover" />
          <p className="font-semibold text-phx-ink-2">No requests were returned from the data source.</p>
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
        <AdminPageHero
          description="Review uploaded history, employee requests, manual entries, eligibility, claimed amount, evidence, route validation, and final admin decisions."
          eyebrow="Outstation expenses"
          icon={<ShieldAlert className="h-3.5 w-3.5" />}
          title="Outstation expenses"
          actions={(
            <div className="flex flex-wrap items-center gap-2">
              <ExportXlsxButton
                className="h-9 rounded-xl"
                columns={exportColumns}
                rows={exportRows}
                sheetName="Outstation expenses"
                subtitle={exportSubtitle}
                title="Outstation expenses"
              />
              <Button
                className="gap-2 rounded-xl bg-phx-accent-hover px-4 py-2 text-xs font-black text-white hover:bg-phx-accent-press"
                onClick={() => setManagerExpenseModal({ mode: "create" })}
                type="button"
              >
                <PlusCircle className="h-4 w-4" />
                Add manual expense
              </Button>
            </div>
          )}
          badges={(
            <>
              <AdminInsightChip tone="orange">Requests: {filtered.length}</AdminInsightChip>
              <AdminInsightChip tone="slate">Claimed: {formatCurrency(totals.claimed)}</AdminInsightChip>
              <AdminInsightChip tone="emerald">Approved: {totals.approved}</AdminInsightChip>
            </>
          )}
        />

        {/* Above the metrics on purpose: a held request is money an employee has not been paid,
            and it is the only thing on this page that is actively waiting on someone. Renders
            nothing at all when the queue is empty. */}
        <HeldRequestsPanel />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Metric label="Requests" value={String(filtered.length)} />
          <Metric label="Submitted" value={String(totals.submitted)} />
          <Metric label="Approved" value={String(totals.approved)} />
          <Metric label="Rejected" value={String(totals.rejected)} />
          <Metric label="Claimed" value={formatCurrency(totals.claimed)} />
        </div>

        <AdminTableShell
          action={hasActiveFilters ? (
            <button
              className="inline-flex rounded-md border border-phx-line bg-white px-3 py-2 text-xs font-semibold text-phx-ink-soft shadow-sm transition hover:border-phx-accent hover:text-phx-accent-hover"
              onClick={clearFilters}
              type="button"
            >
              Clear filters
            </button>
          ) : null}
          description="Search by employee or location and filter by eligibility and role."
          title="Request filters"
        >
          <div className="grid gap-4 p-4 sm:p-5 md:grid-cols-2 xl:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">Search</span>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-faint" />
                <Input
                  className="pl-9"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Employee, HR ID, area, city"
                  value={search}
                />
              </div>
            </label>

            <label className="block">
              <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">Eligibility</span>
              <SearchableSelect
                className="w-full px-3"
                onChange={(event) => setEligibility(event.target.value)}
                value={eligibility}
              >
                <option value="">All</option>
                <option value="eligible">Eligible</option>
                <option value="not_eligible">Not Eligible</option>
                <option value="needs_review">Needs Review</option>
              </SearchableSelect>
            </label>

            <label className="block">
              <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">Role</span>
              <SearchableSelect
                className="w-full px-3"
                onChange={(event) => setRole(event.target.value)}
                value={role}
              >
                <option value="">All</option>
                {roles.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </SearchableSelect>
            </label>

            <label className="block">
              <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">Month</span>
              <SearchableSelect
                className="w-full px-3"
                onChange={(event) => setMonth(event.target.value)}
                value={month}
              >
                <option value="">All months</option>
                {months.map((key) => (
                  <option key={key} value={key}>
                    {formatMonthLabel(key)}
                  </option>
                ))}
              </SearchableSelect>
            </label>
          </div>
        </AdminTableShell>

        <Card className={`${panelClassName} overflow-hidden p-0`}>
            <div className="relative overflow-hidden border-b border-[#1F2937] bg-[radial-gradient(circle_at_top_right,rgba(249,115,22,0.24),transparent_34%),linear-gradient(135deg,#080B10_0%,#111827_58%,#24150D_100%)] px-5 py-5 text-white">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-16 -top-20 h-44 w-44 rounded-full bg-phx-accent/20 blur-3xl"
              />
              <div className="relative z-10 space-y-1.5">
                <p className="inline-flex rounded-full border border-phx-accent/35 bg-phx-accent/12 px-3 py-1 text-xs font-black uppercase tracking-[0.16em] text-phx-accent">Request queue</p>
                <h2 className="text-xl font-black text-white">Outstation expense queue</h2>
                <p className="text-sm text-phx-line-strong">Open any row to inspect evidence, route metrics, location validation, and admin decisions.</p>
              </div>
            </div>

            {/* Below `md` the queue is a card list. The table is 1,240px wide with two sticky
                columns, so on a phone the Actions column — View and Edit, the only things you can
                actually DO here — sat permanently off the right edge behind a sideways scroll.
                Tapping the employee name selects the request, which is what tapping the row does
                on desktop; View and Edit are real buttons, so they cannot nest inside it. */}
            <div className="divide-y divide-slate-100 md:hidden">
              {filtered.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm font-semibold text-slate-400">
                  No requests match these filters.
                </p>
              ) : (
                filtered.map((request) => (
                  <PortalRecordCard
                    accent={request.id === selectedRequest?.id ? "orange" : "slate"}
                    actions={
                      <>
                        <Button
                          className="gap-1.5 rounded-xl border border-[#DDE6F1] bg-white px-3 py-2 text-xs font-black text-phx-ink"
                          onClick={() => openDetails(request)}
                          type="button"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          View
                        </Button>
                        <Button
                          className="gap-1.5 rounded-xl border border-[#FED7AA] bg-phx-accent-soft px-3 py-2 text-xs font-black text-phx-accent-hover"
                          onClick={() => setManagerExpenseModal({ mode: "edit", request })}
                          type="button"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                          Edit
                        </Button>
                        {request.distanceFromResidenceKm == null ? (
                          <Button
                            className="gap-1.5 rounded-none border border-[#DDE6F1] bg-white px-3 py-2 text-xs font-black text-phx-ink"
                            disabled={acting?.id === request.id}
                            onClick={() => fillDistance(request)}
                            title="Measure the distance from the employee's home. No amount changes."
                            type="button"
                          >
                            <MapPinned className="h-3.5 w-3.5" />
                            Fill distance
                          </Button>
                        ) : null}
                      </>
                    }
                    key={request.id}
                    meta={`${request.employeeHrId} - ${request.employeeRole}`}
                    status={
                      <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${requestStatusTone(request.status)}`}>
                        {formatStatus(request.status)}
                      </span>
                    }
                    title={
                      <button className="text-left" onClick={() => selectRequest(request)} type="button">
                        {formatEmployeeDisplayName(request.employeeName)}
                      </button>
                    }
                  >
                    <PortalRecordFields
                      fields={[
                        { label: "Trip", value: `${formatDate(request.tripStartDate)} to ${formatDate(request.tripEndDate)}` },
                        { label: "Distance", value: formatKm(request.distanceFromResidenceKm) },
                        { label: "Eligibility", value: formatStatus(request.eligibilityStatus) },
                        { label: "Claimed", value: formatCurrency(request.claimedTotalAmount) },
                        { label: "Recommendation", value: formatStatus(request.approvalRecommendation) },
                      ]}
                    />
                  </PortalRecordCard>
                ))
              )}
            </div>

            <div className="hidden max-h-[68vh] overflow-auto md:block">
              <table className="min-w-[1240px] w-full border-separate border-spacing-0 text-left text-sm">
                <thead className="sticky top-0 z-40 bg-phx-paper text-phx-xs uppercase tracking-[0.16em] text-phx-ink-soft">
                  <tr>
                    <th className={stickyEmployeeHeaderClassName}>Employee</th>
                    <th className={stickyTripHeaderClassName}>Trip</th>
                    <th className={adminTableHeaderClassName}>Distance</th>
                    <th className={adminTableHeaderClassName}>Eligibility</th>
                    <th className={adminTableHeaderClassName}>Status</th>
                    <th className={adminTableHeaderClassName}>Claimed</th>
                    <th className={adminTableHeaderClassName}>Recommendation</th>
                    <th className={adminTableHeaderClassName}>Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-phx-line bg-white">
                  {filtered.map((request) => {
                    const selected = request.id === selectedRequest?.id;
                    const stickyCellBg = selected ? "bg-phx-accent-soft" : "bg-white";
                    return (
                      <tr
                        className={`cursor-pointer ${selected ? "bg-phx-accent-soft ring-1 ring-inset ring-phx-accent-line/60" : "transition-colors hover:bg-phx-accent-soft/65"}`}
                        key={request.id}
                        onClick={() => selectRequest(request)}
                      >
                        <td className={`${stickyEmployeeCellClassName} ${stickyCellBg}`}>
                          <div className="font-bold text-phx-ink">{formatEmployeeDisplayName(request.employeeName)}</div>
                          <div className="text-xs text-phx-ink-soft">{`${request.employeeHrId} - ${request.employeeRole}`}</div>
                        </td>
                        <td className={`${stickyTripCellClassName} ${stickyCellBg} text-phx-ink-soft`}>
                          {formatDate(request.tripStartDate)} to {formatDate(request.tripEndDate)}
                        </td>
                        <td className="px-4 py-3 font-semibold text-phx-ink">
                          {formatKm(request.distanceFromResidenceKm)}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${statusTone(request.eligibilityStatus)}`}>
                            {formatStatus(request.eligibilityStatus)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${requestStatusTone(request.status)}`}>
                            {formatStatus(request.status)}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-semibold text-phx-ink-soft">
                          {formatCurrency(request.claimedTotalAmount)}
                        </td>
                        <td className={`px-4 py-3 text-phx-xs font-black uppercase tracking-[0.14em] ${recommendationTone(request.approvalRecommendation)}`}>
                          {formatStatus(request.approvalRecommendation)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <Button
                              className="gap-1.5 rounded-xl border border-[#DDE6F1] bg-white px-3 py-2 text-xs font-black text-phx-ink hover:bg-phx-accent-soft"
                              onClick={(event) => {
                                event.stopPropagation();
                                openDetails(request);
                              }}
                              type="button"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              View
                            </Button>
                            <Button
                              className="gap-1.5 rounded-xl border border-[#FED7AA] bg-phx-accent-soft px-3 py-2 text-xs font-black text-phx-accent-hover hover:bg-[#FFEDD5]"
                              onClick={(event) => {
                                event.stopPropagation();
                                setManagerExpenseModal({ mode: "edit", request });
                              }}
                              title="Edit expense details and recalculate distance"
                              type="button"
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                              Edit
                            </Button>
                            {request.distanceFromResidenceKm == null ? (
                              <Button
                                className="gap-1.5 rounded-none border border-[#DDE6F1] bg-white px-3 py-2 text-xs font-black text-phx-ink hover:bg-phx-accent-soft"
                                disabled={acting?.id === request.id}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  fillDistance(request);
                                }}
                                title="Measure the distance from the employee's home. No amount changes."
                                type="button"
                              >
                                <MapPinned className="h-3.5 w-3.5" />
                                Fill distance
                              </Button>
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

      {/* The details modal is `fixed inset-0 z-[200]`, portalled to document.body. At z-40 this
          toast painted behind its backdrop, so an action taken from inside the modal — which is
          the ONLY place the approve button lives — reported nothing at all when it failed. */}
      {actionMessage && !acting ? (
        <div className="fixed bottom-4 right-4 z-[300] max-w-md rounded-md border border-[#A7F3D0] bg-[#ECFDF5] px-4 py-3 text-sm font-semibold text-[#047857] shadow-xl">
          {actionMessage}
        </div>
      ) : null}
      {actionError && !acting ? (
        <div role="alert" className="fixed bottom-4 right-4 z-[300] max-w-md rounded-md border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-sm font-semibold text-[#B91C1C] shadow-xl">
          {actionError}
        </div>
      ) : null}
      {detailRequest ? (
        <RequestDetailsModal
          actionError={actionError}
          actionMessage={actionMessage}
          acting={acting}
          actionRequestId={actionRequestId}
          canApprove={canApprove}
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
