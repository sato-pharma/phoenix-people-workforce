"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Archive,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  History,
  RefreshCcw,
  Search,
  Undo2,
  Wallet,
  XCircle,
} from "lucide-react";

import {
  ApprovalHistory,
  egp,
  formatDate,
  formatDateTime,
} from "@/components/employee-portal/marketing-approval-chain";
import {
  PortalDesktopTable,
  PortalMetricCard,
  PortalPagination,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type {
  MarketingApproverHistoryOutcome,
  MarketingApproverHistoryRow,
  MarketingApproverHistoryWorkspace,
} from "@/lib/marketing-requests/service";

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Outcome presentation ------------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

/** The label itself comes from the server (MARKETING_HISTORY_OUTCOME_LABEL) — this is only tone. */
const OUTCOME_VARIANT: Record<MarketingApproverHistoryOutcome, "neutral" | "success" | "warning" | "danger"> = {
  approved: "success",
  archived: "neutral",
  closed: "neutral",
  in_flight: "warning",
  rejected: "danger",
  returned: "warning",
};

const OUTCOME_ICON: Record<MarketingApproverHistoryOutcome, typeof CheckCircle2> = {
  approved: CheckCircle2,
  archived: Archive,
  closed: Archive,
  in_flight: History,
  rejected: XCircle,
  returned: Undo2,
};

const OUTCOME_ACCENT: Record<MarketingApproverHistoryOutcome, string> = {
  approved: "from-white via-emerald-50/40 to-white",
  archived: "from-white via-slate-50 to-white",
  closed: "from-white via-slate-50 to-white",
  in_flight: "from-white via-orange-50/30 to-white",
  rejected: "from-white via-rose-50/40 to-white",
  returned: "from-white via-amber-50/40 to-white",
};

/** Left-edge accent for the desktop detail row, keyed to the same tone as the badge. Written as
 *  whole static class strings — Tailwind never sees a class name assembled from a variable at
 *  runtime, so an interpolated colour class is purged from the bundle and paints nothing. */
const OUTCOME_DETAIL_BORDER: Record<MarketingApproverHistoryOutcome, string> = {
  approved: "border-l-emerald-500",
  archived: "border-l-slate-400",
  closed: "border-l-slate-400",
  in_flight: "border-l-orange-500",
  rejected: "border-l-rose-500",
  returned: "border-l-amber-500",
};

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Shared decision detail (identical on the mobile card and the desktop expansion) --------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

/**
 * The full record of a decided request: the final response, what THIS viewer did, the whole
 * approval trail, and the four dates/values. Rendered in one place so a past approval reads
 * identically whether it is opened on a phone card or expanded from the desktop table.
 */
function HistoryDecisionDetail({ row }: { row: MarketingApproverHistoryRow }) {
  const decidedAt = formatDateTime(row.decidedAt);
  const myDecidedAt = formatDateTime(row.myDecision?.at ?? null);

  return (
    <div className="divide-y divide-slate-100">
      {/* ------ The response itself: who ended it, when, and in their own words -----------------
          This is the answer the tab is opened for. It sits ABOVE the full chain because the last
          word is what anyone is looking for, and the chain below is the supporting record. */}
      <div className="px-4 py-3">
        <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">Final response</p>
        {row.finalStepName ? (
          <>
            <p className="mt-1 text-[12px] font-bold text-slate-800">
              {row.outcomeLabel} at {row.finalStepName}
              {row.finalApproverName ? ` by ${row.finalApproverName}` : ""}
              {decidedAt ? ` · ${decidedAt}` : ""}
            </p>
            {/* Never truncated. A rejection reason that is cut off is a rejection nobody can act on. */}
            {row.finalDecisionNote ? (
              <p className="mt-1.5 rounded-sm border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[12px] font-medium leading-snug text-slate-700">
                &ldquo;{row.finalDecisionNote}&rdquo;
              </p>
            ) : (
              <p className="mt-1 text-[11px] font-medium italic text-slate-400">No comment left with the decision</p>
            )}
          </>
        ) : (
          // Not an invented outcome: a request can carry a final status with no decided rung behind
          // it (a legacy import, or a status set outside the chain). Saying so beats guessing.
          <p className="mt-1 text-[12px] font-bold text-slate-800">
            {row.outcomeLabel}
            {decidedAt ? ` · ${decidedAt}` : ""} — no decision was recorded on the approval chain.
          </p>
        )}
      </div>

      {/* ------ What THIS viewer did, when they were part of it ----------------------------------- */}
      {row.myDecision ? (
        <div className="bg-slate-900/[0.03] px-4 py-2.5">
          <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">Your decision</p>
          <p className="mt-0.5 text-[12px] font-bold text-slate-800">
            {row.myDecision.stepName}
            {myDecidedAt ? ` · ${myDecidedAt}` : ""}
          </p>
          {row.myDecision.note ? (
            <p className="mt-1 text-[11px] font-medium leading-snug text-slate-600">
              &ldquo;{row.myDecision.note}&rdquo;
            </p>
          ) : null}
        </div>
      ) : row.isMyRequest ? (
        <div className="bg-sky-50/60 px-4 py-2 text-[11px] font-semibold text-sky-800">
          You raised this request — this is the answer it came back with.
        </div>
      ) : row.viaOversight ? (
        <div className="px-4 py-2 text-[11px] font-medium text-slate-400">
          You held no step on this request — shown because you can see the whole company queue.
        </div>
      ) : null}

      <ApprovalHistory rungs={row.approvalHistory} title="Full approval trail" />

      <div className="grid gap-3 px-4 py-3 sm:grid-cols-4">
        <div className="flex flex-col">
          <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">Estimated Cost</span>
          <span className="text-[13px] font-black text-slate-950">{egp(row.estimatedCost)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">Pay Date</span>
          <span className="flex items-center gap-1 text-[13px] font-bold text-slate-700">
            <CalendarDays className="h-3 w-3 text-slate-400" />
            {formatDate(row.payDate)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">Submitted</span>
          <span className="text-[13px] font-bold text-slate-700">{formatDate(row.submittedAt)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">Decided</span>
          <span className="text-[13px] font-bold text-slate-700">{formatDate(row.decidedAt)}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 bg-slate-50/50 px-4 py-3">
        <Link
          className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-slate-300 bg-white px-4 text-[12px] font-bold text-slate-700 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
          href={`/marketing-requests/${row.id}`}
        >
          <Eye className="h-3.5 w-3.5" />
          Open the full record
        </Link>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Mobile card (never a table below `md`, owner rule) -------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function HistoryMobileCard({ row }: { row: MarketingApproverHistoryRow }) {
  const Icon = OUTCOME_ICON[row.outcome];

  return (
    <Card className="rounded-sm border border-slate-200 bg-white p-0 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
      <div
        className={`flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 bg-gradient-to-r px-4 py-3 ${OUTCOME_ACCENT[row.outcome]}`}
      >
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{row.requestCode}</p>
          {/* Owner rules: never truncate with an ellipsis, never wrap to a second line. On a 375px
              phone a long pharmacy name honours both by SCROLLING inside its own box — measured
              459px of text in a 317px box, so without this it painted 113px off the screen edge. */}
          <div className="overflow-x-auto">
            <h3 className="mt-0.5 whitespace-nowrap text-[15px] font-black tracking-tight text-slate-950">
              {row.customerName}
            </h3>
          </div>
          <p className="mt-0.5 text-[11px] font-medium text-slate-500">
            {row.requestType} · From {row.requesterName} ({row.requesterRole})
          </p>
        </div>
        <Badge className="shrink-0" variant={OUTCOME_VARIANT[row.outcome]}>
          <Icon className="mr-1 h-3 w-3" />
          {row.outcomeLabel}
        </Badge>
      </div>

      <HistoryDecisionDetail row={row} />
    </Card>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Desktop table row (scan first; the full trail opens on click) --------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

const DESKTOP_COLUMNS = 7;

function HistoryTableRow({
  isOpen,
  onToggle,
  row,
}: {
  isOpen: boolean;
  onToggle: () => void;
  row: MarketingApproverHistoryRow;
}) {
  const Icon = OUTCOME_ICON[row.outcome];
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  // The final word, in one scannable line. Never wrapped or clipped — the table scrolls sideways
  // inside its own box instead, so a long approver name widens the column rather than losing text.
  const finalResponse = row.finalStepName
    ? `${row.finalStepName}${row.finalApproverName ? ` · ${row.finalApproverName}` : ""}`
    : "Not decided on the chain";

  return (
    <>
      <tr
        className="cursor-pointer border-b border-slate-100 transition hover:bg-orange-50/30"
        onClick={onToggle}
      >
        <td className="whitespace-nowrap px-3 py-2.5 text-[12px] font-bold text-slate-500">{row.requestCode}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-[13px] font-black text-slate-950">{row.customerName}</td>
        <td className="whitespace-nowrap px-3 py-2.5">
          <Badge variant={OUTCOME_VARIANT[row.outcome]}>
            <Icon className="mr-1 h-3 w-3" />
            {row.outcomeLabel}
          </Badge>
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-[12px] font-bold text-slate-700">{finalResponse}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-[13px] font-black text-slate-950">{egp(row.estimatedCost)}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-[12px] font-bold text-slate-700">{formatDate(row.decidedAt)}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right">
          <button
            aria-expanded={isOpen}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-3 text-[12px] font-bold text-slate-600 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            type="button"
          >
            <Chevron className="h-3.5 w-3.5" />
            {isOpen ? "Hide trail" : "Full trail"}
          </button>
        </td>
      </tr>
      {isOpen ? (
        <tr className={`border-b border-slate-100 border-l-[3px] ${OUTCOME_DETAIL_BORDER[row.outcome]} bg-slate-50/40`}>
          <td colSpan={DESKTOP_COLUMNS} className="p-0">
            <HistoryDecisionDetail row={row} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Skeleton --------------------------------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function HistorySkeleton() {
  return (
    <div className="animate-pulse space-y-2 rounded-sm border border-slate-200 bg-white p-4">
      <div className="h-3 w-40 rounded-sm bg-slate-200" />
      <div className="h-2.5 w-56 rounded-sm bg-slate-100" />
      <div className="h-2.5 w-32 rounded-sm bg-slate-100" />
    </div>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Main ------------------------------------------------------------------------------------------------------------------------------------ */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

const HISTORY_PAGE_SIZE = 25;

/**
 * The inbox's History tab: every marketing request that has already been answered.
 *
 * Loads lazily — this component is only mounted once the tab is actually opened, so the default
 * "In approval" view costs exactly what it did before.
 *
 * Built to the same identity as the live "In approval" tab it sits beside: a metric strip that
 * answers "how much was decided, and how did it land" before a single row is read; a scannable
 * desktop TABLE with the full approval trail one click away; the rich card only below `md`, where
 * the owner rule is cards, never a table; and the list windowed so a long history is paged, not a
 * wall of expanded trails.
 */
export function MarketingRequestHistory() {
  const [rows, setRows] = useState<MarketingApproverHistoryRow[]>([]);
  const [scope, setScope] = useState<MarketingApproverHistoryWorkspace["scope"]>("mine");
  const [truncated, setTruncated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState<MarketingApproverHistoryOutcome | "all">("all");
  const [page, setPage] = useState(0);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/marketing-requests/inbox/history", { cache: "no-store" });
      const payload = (await response.json()) as MarketingApproverHistoryWorkspace | { message?: string };
      if (!response.ok) {
        setRows([]);
        setTruncated(false);
        setError(("message" in payload && payload.message) || "Unable to load the approval history.");
        return;
      }
      setRows((payload as MarketingApproverHistoryWorkspace).rows ?? []);
      setScope((payload as MarketingApproverHistoryWorkspace).scope ?? "mine");
      setTruncated(Boolean((payload as MarketingApproverHistoryWorkspace).truncated));
      setError(null);
    } catch {
      setRows([]);
      setTruncated(false);
      setError("Unable to load the approval history.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadHistory();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadHistory]);

  // Only the outcomes actually present get a chip — a filter for a state nothing is in reads as a
  // gap in the data rather than as an empty category.
  const outcomeChips = useMemo(() => {
    const counts = new Map<MarketingApproverHistoryOutcome, { count: number; label: string }>();
    for (const row of rows) {
      const entry = counts.get(row.outcome);
      counts.set(row.outcome, { count: (entry?.count ?? 0) + 1, label: row.outcomeLabel });
    }
    return Array.from(counts.entries()).map(([outcome, entry]) => ({ ...entry, outcome }));
  }, [rows]);

  // What this history is worth and how it landed, before any of it is read.
  const summary = useMemo(() => {
    let approved = 0;
    let rejected = 0;
    let returned = 0;
    let value = 0;
    for (const row of rows) {
      if (row.outcome === "approved") approved += 1;
      else if (row.outcome === "rejected") rejected += 1;
      else if (row.outcome === "returned") returned += 1;
      value += row.estimatedCost ?? 0;
    }
    return { approved, rejected, returned, value };
  }, [rows]);

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (outcomeFilter !== "all" && row.outcome !== outcomeFilter) return false;
      if (!needle) return true;
      return [row.requestCode, row.customerName, row.requesterName, row.requestType, row.finalStepName ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [outcomeFilter, rows, search]);

  // Clamped during render, never from an effect (which is a lint error here): a filter that
  // shortens the list must not strand the reader on a page that no longer exists.
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / HISTORY_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pagedRows = visibleRows.slice(safePage * HISTORY_PAGE_SIZE, safePage * HISTORY_PAGE_SIZE + HISTORY_PAGE_SIZE);

  const toggleRow = useCallback((id: string) => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="space-y-3" dir="auto">
      {/* ------ Header + Refresh ------------------------------------------------------------------ */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-slate-100 text-slate-600 ring-1 ring-slate-200">
            <History className="h-3.5 w-3.5" />
          </div>
          <div>
            <h2 className="text-[15px] font-black tracking-tight text-slate-950">
              {scope === "company" ? "Every request already decided" : "Requests you took part in"}
            </h2>
            <p className="text-[11px] font-medium text-slate-400">
              {isLoading
                ? "Loading…"
                : `${visibleRows.length} of ${rows.length} request${rows.length === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>
        <button
          aria-label="Refresh history"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600"
          onClick={() => {
            setIsLoading(true);
            setError(null);
            void loadHistory();
          }}
          title="Refresh history"
          type="button"
        >
          {isLoading ? <LoadingSpinner /> : <RefreshCcw className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* ------ Error ---------------------------------------------------------------------------- */}
      {error ? (
        <div className="flex items-center gap-2 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] font-semibold text-amber-900">
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : null}

      {/* ------ How this history landed, at a glance ---------------------------------------------
          A card only when it has something to count — an empty category padded onto the strip
          reads as a gap in the data rather than as a zero worth showing (owner rule: never pad). */}
      {!isLoading && rows.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <PortalMetricCard
            accent="slate"
            icon={History}
            label="Decided"
            note="Approved, rejected or returned"
            value={rows.length}
          />
          {summary.approved > 0 ? (
            <PortalMetricCard
              accent="emerald"
              icon={CheckCircle2}
              label="Approved"
              note="Cleared the whole chain"
              value={summary.approved}
            />
          ) : null}
          {summary.returned > 0 ? (
            <PortalMetricCard
              accent="amber"
              icon={Undo2}
              label="Returned"
              note="Sent back for a change"
              value={summary.returned}
            />
          ) : null}
          {summary.rejected > 0 ? (
            <PortalMetricCard
              accent="rose"
              icon={XCircle}
              label="Rejected"
              note="Turned down on the chain"
              value={summary.rejected}
            />
          ) : null}
          {summary.value > 0 ? (
            <PortalMetricCard
              accent="orange"
              icon={Wallet}
              label="Value decided"
              note="Estimated cost across this history"
              value={egp(summary.value)}
            />
          ) : null}
        </div>
      ) : null}

      {/* ------ Search + outcome filter ------------------------------------------------------------ */}
      {!isLoading && rows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-sm border border-slate-200 bg-white px-3 shadow-sm sm:max-w-xs">
            <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            {/* 16px floor: anything smaller makes iOS Safari zoom the page on focus. */}
            <input
              className="min-h-10 w-full min-w-0 border-0 bg-transparent text-[16px] font-medium text-slate-800 outline-none placeholder:text-slate-400 sm:text-[13px]"
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
              placeholder="Search code, customer, requester"
              type="search"
              value={search}
            />
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              aria-pressed={outcomeFilter === "all"}
              className={`min-h-9 rounded-sm border px-3 text-[12px] font-bold transition ${
                outcomeFilter === "all"
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
              onClick={() => {
                setOutcomeFilter("all");
                setPage(0);
              }}
              type="button"
            >
              All ({rows.length})
            </button>
            {outcomeChips.map((chip) => (
              <button
                aria-pressed={outcomeFilter === chip.outcome}
                className={`min-h-9 rounded-sm border px-3 text-[12px] font-bold transition ${
                  outcomeFilter === chip.outcome
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
                key={chip.outcome}
                onClick={() => {
                  setOutcomeFilter(chip.outcome);
                  setPage(0);
                }}
                type="button"
              >
                {chip.label} ({chip.count})
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* ------ The cap, said out loud rather than hidden ------------------------------------------ */}
      {truncated ? (
        <div className="rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-900">
          Showing the most recently decided requests only. Older ones are in the full marketing
          request register.
        </div>
      ) : null}

      {/* ------ Body ------------------------------------------------------------------------------ */}
      {isLoading ? (
        <div className="space-y-3">
          <HistorySkeleton />
          <HistorySkeleton />
        </div>
      ) : rows.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-2 rounded-sm border border-slate-200 bg-white px-4 py-10 text-center shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="flex h-10 w-10 items-center justify-center rounded-sm bg-slate-50 text-slate-400 ring-1 ring-slate-100">
            <History className="h-4 w-4" />
          </div>
          <p className="text-[14px] font-black text-slate-800">Nothing has been decided yet</p>
          <p className="max-w-sm text-[12px] font-medium text-slate-500">
            {scope === "company"
              ? "No marketing request has been approved, rejected or returned so far."
              : "Once a request you raised — or one you are an approver on — is answered, it moves here with the full decision trail."}
          </p>
        </Card>
      ) : visibleRows.length === 0 ? (
        <Card className="rounded-sm border border-slate-200 bg-white px-4 py-8 text-center shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <p className="text-[13px] font-bold text-slate-700">No request matches this filter.</p>
        </Card>
      ) : (
        <Card className="overflow-hidden rounded-sm border border-slate-200 bg-white p-0 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <PortalResponsiveDataList
            empty={
              <p className="px-4 py-8 text-center text-[13px] font-bold text-slate-500">
                No request matches this filter.
              </p>
            }
            getKey={(row) => `history-${row.id}`}
            items={[...pagedRows]}
            renderCard={(row) => <HistoryMobileCard row={row} />}
            renderTable={() => (
              <PortalDesktopTable minWidth="1040px">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    {["Request", "Customer", "Outcome", "Final response", "Value", "Decided", ""].map(
                      (heading, index) => (
                        <th
                          className="whitespace-nowrap px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.12em] text-slate-500"
                          key={`${heading}-${index}`}
                          scope="col"
                        >
                          {heading}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((row) => (
                    <HistoryTableRow
                      isOpen={openIds.has(row.id)}
                      key={`history-row-${row.id}`}
                      onToggle={() => toggleRow(row.id)}
                      row={row}
                    />
                  ))}
                </tbody>
              </PortalDesktopTable>
            )}
          />
          {visibleRows.length > HISTORY_PAGE_SIZE ? (
            <PortalPagination
              label={`Showing ${safePage * HISTORY_PAGE_SIZE + 1}–${safePage * HISTORY_PAGE_SIZE + pagedRows.length} of ${visibleRows.length}`}
            >
              <button
                className="min-h-9 rounded-sm border border-slate-200 bg-white px-3 text-[12px] font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
                disabled={safePage === 0}
                onClick={() => setPage(Math.max(0, safePage - 1))}
                type="button"
              >
                Previous
              </button>
              <button
                className="min-h-9 rounded-sm border border-slate-200 bg-white px-3 text-[12px] font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
                type="button"
              >
                Next
              </button>
            </PortalPagination>
          ) : null}
        </Card>
      )}
    </div>
  );
}
