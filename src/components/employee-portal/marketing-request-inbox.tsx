"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CalendarDays,
  CheckCircle2,
  Clock3,
  Inbox,
  MessageSquareText,
  RefreshCcw,
  Undo2,
  XCircle,
} from "lucide-react";

import { MarketingAdvisoryCommentBox } from "@/components/employee-portal/marketing-advisory-comment-box";
import { MarketingRequestedProductHistory } from "@/components/marketing-requests/marketing-requested-product-history";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import type {
  MarketingApproverInboxRow,
  MarketingApproverInboxWorkspace,
  MarketingApproverUpcomingRow,
} from "@/lib/marketing-requests/service";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Helpers ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDate(value: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
  });
}

function decisionHref(basePath: string, requestId: string, decision: "approve" | "reject" | "return") {
  return `${basePath}/${requestId}?decision=${decision}`;
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Skeleton --------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function RowSkeleton() {
  return (
    <div className="animate-pulse space-y-2 rounded-sm border border-slate-200 bg-white p-4">
      <div className="h-3 w-32 rounded-sm bg-slate-200" />
      <div className="h-2.5 w-48 rounded-sm bg-slate-100" />
      <div className="flex gap-2">
        <div className="h-8 w-24 rounded-sm bg-slate-100" />
        <div className="h-8 w-24 rounded-sm bg-slate-100" />
        <div className="h-8 w-24 rounded-sm bg-slate-100" />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Row card --------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function InboxRowCard({ decisionBasePath, row }: { decisionBasePath: string; row: MarketingApproverInboxRow }) {
  return (
    <Card className="rounded-sm border border-slate-200 bg-white p-0 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 bg-gradient-to-r from-white via-orange-50/30 to-white px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-orange-600">
            {row.requestCode}
          </p>
          <h3 className="mt-0.5 whitespace-nowrap text-[15px] font-black tracking-tight text-slate-950">
            {row.customerName}
          </h3>
          <p className="mt-0.5 text-[11px] font-medium text-slate-500">
            {row.requestType} · From {row.requesterName} ({row.requesterRole})
          </p>
        </div>
        <Badge variant="warning">{row.currentStepName}</Badge>
      </div>

      {/* Sales history for the products THIS request promotes — owner instruction, 2026-08-04.
          Lives on the row itself, not one click away: the approver's first question is whether
          this customer has ever bought what is being pushed, and a request whose promoted products
          have no history here is the one worth stopping before opening anything. */}
      <div className="border-b border-slate-100 px-4 py-3">
        <MarketingRequestedProductHistory requestId={row.id} />
      </div>

      <div className="grid gap-3 px-4 py-3 sm:grid-cols-3">
        <div className="flex flex-col">
          <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">
            Estimated Cost
          </span>
          <span className="text-[13px] font-black text-slate-950">
            {egp(row.estimatedCost)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">
            Pay Date
          </span>
          <span className="flex items-center gap-1 text-[13px] font-bold text-slate-700">
            <CalendarDays className="h-3 w-3 text-slate-400" />
            {formatDate(row.payDate)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">
            Submitted
          </span>
          <span className="text-[13px] font-bold text-slate-700">
            {formatDate(row.submittedAt)}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/50 px-4 py-3">
        <Link
          className="inline-flex min-h-9 items-center gap-1.5 rounded-sm bg-emerald-600 px-4 text-[12px] font-bold text-white shadow-sm transition hover:bg-emerald-700"
          href={decisionHref(decisionBasePath, row.id, "approve")}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {row.decisionLabels.approve}
        </Link>
        <Link
          className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-amber-300 bg-white px-4 text-[12px] font-bold text-amber-800 shadow-sm transition hover:bg-amber-50"
          href={decisionHref(decisionBasePath, row.id, "return")}
        >
          <Undo2 className="h-3.5 w-3.5" />
          {row.decisionLabels.return}
        </Link>
        <Link
          className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-rose-300 bg-white px-4 text-[12px] font-bold text-rose-700 shadow-sm transition hover:bg-rose-50"
          href={decisionHref(decisionBasePath, row.id, "reject")}
        >
          <XCircle className="h-3.5 w-3.5" />
          {row.decisionLabels.reject}
        </Link>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Main ------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function AdvisoryRowCard({ onPosted, row }: { onPosted: () => void; row: MarketingApproverInboxRow }) {
  return (
    <Card className="rounded-sm border border-sky-200 bg-white p-0 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 bg-gradient-to-r from-white via-sky-50/40 to-white px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-sky-600">{row.requestCode}</p>
          <h3 className="mt-0.5 whitespace-nowrap text-[15px] font-black tracking-tight text-slate-950">{row.customerName}</h3>
          <p className="mt-0.5 text-[11px] font-medium text-slate-500">
            {row.requestType} · From {row.requesterName} ({row.requesterRole})
          </p>
        </div>
        <Badge variant="neutral">For your comment</Badge>
      </div>

      <div className="px-4 py-3">
        <MarketingAdvisoryCommentBox onPosted={onPosted} requestId={row.id} />
      </div>
    </Card>
  );
}

function MarketingRequestInboxInner({ decisionBasePath }: { decisionBasePath: string }) {
  const [rows, setRows] = useState<MarketingApproverInboxRow[]>([]);
  const [advisoryRows, setAdvisoryRows] = useState<MarketingApproverInboxRow[]>([]);
  const [upcomingRows, setUpcomingRows] = useState<MarketingApproverUpcomingRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInbox = useCallback(async () => {
    try {
      const response = await fetch("/api/marketing-requests/inbox", {
        cache: "no-store",
      });
      const payload = (await response.json()) as
        | MarketingApproverInboxWorkspace
        | { message?: string };
      if (!response.ok) {
        setRows([]);
        setAdvisoryRows([]);
        setError(
          ("message" in payload && payload.message) ||
            "Unable to load your approval inbox.",
        );
        return;
      }

      setRows((payload as MarketingApproverInboxWorkspace).rows ?? []);
      setAdvisoryRows((payload as MarketingApproverInboxWorkspace).advisoryRows ?? []);
      setUpcomingRows((payload as MarketingApproverInboxWorkspace).upcomingRows ?? []);
      setError(null);
    } catch {
      setRows([]);
      setAdvisoryRows([]);
      setUpcomingRows([]);
      setError("Unable to load your approval inbox.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadInbox();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadInbox]);

  return (
    <div className="space-y-3" dir="auto">
      {/* ------ Header + Refresh ------------------------------------------------------------------------------------------------------------- */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-orange-50 text-orange-600 ring-1 ring-orange-100">
            <Inbox className="h-3.5 w-3.5" />
          </div>
          <div>
            <h2 className="text-[15px] font-black tracking-tight text-slate-950">
              Requests awaiting my decision
            </h2>
            <p className="text-[11px] font-medium text-slate-400">
              {isLoading
                ? "Loading…"
                : `${rows.length} request${rows.length === 1 ? "" : "s"} pending`}
            </p>
          </div>
        </div>
        <button
          aria-label="Refresh inbox"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600"
          onClick={() => {
            setIsLoading(true);
            setError(null);
            void loadInbox();
          }}
          title="Refresh inbox"
          type="button"
        >
          {isLoading ? <LoadingSpinner /> : <RefreshCcw className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* ------ Error ------------------------------------------------------------------------------------------------------------------------------------- */}
      {error ? (
        <div className="flex items-center gap-2 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] font-semibold text-amber-900">
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : null}

      {/* ------ Body ------------------------------------------------------------------------------------------------------------------------------------------- */}
      {isLoading ? (
        <div className="space-y-3">
          <RowSkeleton />
          <RowSkeleton />
        </div>
      ) : rows.length === 0 && advisoryRows.length === 0 && upcomingRows.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-2 rounded-sm border border-slate-200 bg-white px-4 py-10 text-center shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="flex h-10 w-10 items-center justify-center rounded-sm bg-slate-50 text-slate-400 ring-1 ring-slate-100">
            <Inbox className="h-4 w-4" />
          </div>
          <p className="text-[14px] font-black text-slate-800">
            No marketing requests involve you right now
          </p>
          <p className="max-w-sm text-[12px] font-medium text-slate-500">
            Requests appear here from the moment they are submitted — both the ones waiting on you and
            the ones still moving toward your step.
          </p>
        </Card>
      ) : rows.length === 0 ? null : (
        <div className="space-y-3">
          {rows.map((row) => (
          <InboxRowCard decisionBasePath={decisionBasePath} key={row.id} row={row} />
          ))}
        </div>
      )}

      {/* ------ Coming to you: you hold a LATER step, so this is read-only tracking ------------------
          Owner instruction, 2026-08-04. The inbox previously queried status='current' only, so an
          approver above rung 1 saw nothing until the request was already theirs. The CEO sits at
          step 4 of 4 and could be on the hook for a request that had been stalled for days without
          any way to see it. No decision buttons here — it is not their turn — but the request, where
          it is stopped, who holds it, and how long it has been in the system are all visible. */}
      {!isLoading && upcomingRows.length > 0 ? (
        <div className="space-y-3 pt-2">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-amber-50 text-amber-600 ring-1 ring-amber-100">
              <Clock3 className="h-3.5 w-3.5" />
            </div>
            <div>
              <h2 className="text-[15px] font-black tracking-tight text-slate-950">Coming to you</h2>
              <p className="text-[11px] font-medium text-slate-400">
                Requests where you approve later in the chain — not yet your turn
              </p>
            </div>
          </div>
          {upcomingRows.map((row) => (
            <Card
              className="rounded-sm border border-slate-200 bg-white px-4 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.05)]"
              key={row.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[14px] font-black text-slate-950">{row.customerName}</p>
                  <p className="mt-0.5 text-[11px] font-bold text-slate-500">
                    {row.requestCode} · {row.requesterName} · {egp(row.estimatedCost)}
                  </p>
                </div>
                <span className="shrink-0 rounded-sm bg-amber-50 px-2.5 py-1 text-[11px] font-black text-amber-800">
                  {row.ageDays === 0 ? "Submitted today" : `${row.ageDays} ${row.ageDays === 1 ? "day" : "days"} in system`}
                </span>
              </div>
              <p className="mt-2 text-[12px] font-bold text-slate-700">
                {row.awaitingStepName
                  ? `Now with ${row.awaitingApproverName || "an unassigned approver"} — ${row.awaitingStepName}`
                  : "No open approval step on this request."}
              </p>
              <p className="mt-0.5 text-[11px] font-medium text-slate-400">
                Your step is {row.myStepSequence} of {row.totalGatingSteps}
              </p>
            </Card>
          ))}
        </div>
      ) : null}

      {/* ------ Advisory: requests awaiting your comment (non-blocking) ------------------------------- */}
      {!isLoading && advisoryRows.length > 0 ? (
        <div className="space-y-3 pt-2">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-sky-50 text-sky-600 ring-1 ring-sky-100">
              <MessageSquareText className="h-3.5 w-3.5" />
            </div>
            <div>
              <h2 className="text-[15px] font-black tracking-tight text-slate-950">Awaiting your comment</h2>
              <p className="text-[11px] font-medium text-slate-400">
                {advisoryRows.length} request{advisoryRows.length === 1 ? "" : "s"} you can comment on
              </p>
            </div>
          </div>
          {advisoryRows.map((row) => (
            <AdvisoryRowCard key={`advisory-${row.id}`} onPosted={() => void loadInbox()} row={row} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Exported wrapper with error boundary --------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

export function MarketingRequestInbox({
  decisionBasePath = "/employee-portals/marketing-requests/decision",
}: {
  decisionBasePath?: string;
}) {
  return (
    <WorkspaceErrorBoundary fallbackTitle="Marketing approval inbox error">
      <MarketingRequestInboxInner decisionBasePath={decisionBasePath} />
    </WorkspaceErrorBoundary>
  );
}
