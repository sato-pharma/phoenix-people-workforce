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
  Hourglass,
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
import { TableRowDetail, rowDetailToggleProps } from "@/components/ui/table-row-detail";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type {
  MarketingApproverHistoryOutcome,
  MarketingApproverHistoryRow,
  MarketingApproverHistoryWorkspace,
} from "@/lib/marketing-requests/service";
import { adminControlDepthClassName, adminPanelDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Outcome presentation ------------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

/** The label itself comes from the server (MARKETING_HISTORY_OUTCOME_LABEL) — this is only tone. */
const OUTCOME_VARIANT: Record<MarketingApproverHistoryOutcome, "neutral" | "success" | "warning" | "danger"> = {
  approved: "success",
  archived: "neutral",
  awaiting_next_stage: "warning",
  cancelled: "danger",
  closed: "neutral",
  in_flight: "warning",
  rejected: "danger",
  returned: "warning",
};

const OUTCOME_ICON: Record<MarketingApproverHistoryOutcome, typeof CheckCircle2> = {
  approved: CheckCircle2,
  archived: Archive,
  awaiting_next_stage: Hourglass,
  cancelled: XCircle,
  closed: Archive,
  in_flight: History,
  rejected: XCircle,
  returned: Undo2,
};

const OUTCOME_ACCENT: Record<MarketingApproverHistoryOutcome, string> = {
  approved: "from-white via-emerald-50/40 to-white",
  archived: "from-white via-slate-50 to-white",
  awaiting_next_stage: "from-white via-orange-50/30 to-white",
  cancelled: "from-white via-rose-50/40 to-white",
  closed: "from-white via-slate-50 to-white",
  in_flight: "from-white via-orange-50/30 to-white",
  rejected: "from-white via-rose-50/40 to-white",
  returned: "from-white via-amber-50/40 to-white",
};

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Shared decision detail (identical on the mobile card and the desktop expansion) --------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

/**
 * The full record of a decided request: the final response, what THIS viewer did, the whole
 * approval trail, and the four dates/values. Rendered in one place so a past approval reads
 * identically whether it is opened on a phone card or expanded from the desktop table.
 */
function HistoryDecisionDetail({ inTable = false, row }: { inTable?: boolean; row: MarketingApproverHistoryRow }) {
  const decidedAt = formatDateTime(row.decidedAt);
  const myDecidedAt = formatDateTime(row.myDecision?.at ?? null);

  return (
    <div className="divide-y divide-slate-100">
      {/* ------ The response itself: who ended it, when, and in their own words -----------------
          This is the answer the tab is opened for. It sits ABOVE the full chain because the last
          word is what anyone is looking for, and the chain below is the supporting record. */}
      {/* In the desktop table the row already says the outcome, the final step and approver, and the date;
          the panel keeps only what the row cannot: the decision's own words. */}
      {inTable && !row.waitingFor && row.finalStepName ? (
        <div className="px-4 py-3">
          <p className="text-phx-3xs font-bold uppercase tracking-[0.12em] text-slate-400">Decision comment</p>
          {row.finalDecisionNote ? (
            <p className="mt-1.5 border-l-2 border-slate-200 py-1 pl-2.5 text-phx-sm font-medium leading-snug text-slate-700">
              &ldquo;{row.finalDecisionNote}&rdquo;
            </p>
          ) : (
            <p className="mt-1 text-phx-xs font-medium italic text-slate-400">No comment left with the decision</p>
          )}
        </div>
      ) : inTable && row.waitingFor ? null : (
      <div className="px-4 py-3">
        <p className="text-phx-3xs font-bold uppercase tracking-[0.12em] text-slate-400">
          {row.waitingFor ? "Where it is now" : "Final response"}
        </p>
        {row.waitingFor ? (
          // Not finished, and said so: the request is past this viewer's rung and waiting on the next
          // stage. It is never worded as an approval of the whole request.
          <p className="mt-1 text-phx-sm font-bold text-slate-800">
            Waiting for {row.waitingFor.stepName}
            {row.waitingFor.approverName ? ` · ${row.waitingFor.approverName}` : ""}
          </p>
        ) : row.finalStepName ? (
          <>
            <p className="mt-1 text-phx-sm font-bold text-slate-800">
              {row.outcomeLabel} at {row.finalStepName}
              {row.finalApproverName ? ` by ${row.finalApproverName}` : ""}
              {decidedAt ? ` · ${decidedAt}` : ""}
            </p>
            {/* Never truncated. A rejection reason that is cut off is a rejection nobody can act on. */}
            {row.finalDecisionNote ? (
              <p className={`mt-1.5 rounded-sm border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-phx-sm font-medium leading-snug text-slate-700 ${adminSoftDepthClassName}`}>
                &ldquo;{row.finalDecisionNote}&rdquo;
              </p>
            ) : (
              <p className="mt-1 text-phx-xs font-medium italic text-slate-400">No comment left with the decision</p>
            )}
          </>
        ) : (
          // Not an invented outcome: a request can carry a final status with no decided rung behind
          // it (a legacy import, or a status set outside the chain). Saying so beats guessing.
          <p className="mt-1 text-phx-sm font-bold text-slate-800">
            {row.outcomeLabel}
            {decidedAt ? ` · ${decidedAt}` : ""} — no decision was recorded on the approval chain.
          </p>
        )}
      </div>
      )}

      {/* ------ What THIS viewer did, when they were part of it ----------------------------------- */}
      {row.myDecision ? (
        <div className="bg-slate-900/[0.03] px-4 py-2.5">
          <p className="text-phx-3xs font-bold uppercase tracking-[0.12em] text-slate-400">Your decision</p>
          <p className="mt-0.5 text-phx-sm font-bold text-slate-800">
            {row.myDecision.stepName}
            {myDecidedAt ? ` · ${myDecidedAt}` : ""}
          </p>
          {row.myDecision.note ? (
            <p className="mt-1 text-phx-xs font-medium leading-snug text-slate-600">
              &ldquo;{row.myDecision.note}&rdquo;
            </p>
          ) : null}
        </div>
      ) : row.isMyRequest ? (
        <div className="bg-sky-50/60 px-4 py-2 text-phx-xs font-semibold text-sky-800">
          You raised this request — this is the answer it came back with.
        </div>
      ) : row.viaOversight ? (
        <div className="px-4 py-2 text-phx-xs font-medium text-slate-400">
          You held no step on this request — shown because you can see the whole company queue.
        </div>
      ) : null}

      <ApprovalHistory requestCode={row.requestCode} rungs={row.approvalHistory} title="Full approval trail" />

      <div className={`grid gap-3 px-4 py-3 ${inTable ? "sm:grid-cols-2" : "sm:grid-cols-4"}`}>
        {inTable ? null : (
          <div className="flex flex-col">
            <span className="text-phx-3xs font-bold uppercase tracking-[0.12em] text-slate-400">Estimated Cost</span>
            <span className="text-phx-md font-black text-slate-950">{egp(row.estimatedCost)}</span>
          </div>
        )}
        <div className="flex flex-col">
          <span className="text-phx-3xs font-bold uppercase tracking-[0.12em] text-slate-400">Pay Date</span>
          <span className="flex items-center gap-1 text-phx-md font-bold text-slate-700">
            <CalendarDays className="h-3 w-3 text-slate-400" />
            {formatDate(row.payDate)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-phx-3xs font-bold uppercase tracking-[0.12em] text-slate-400">Submitted</span>
          <span className="text-phx-md font-bold text-slate-700">{formatDate(row.submittedAt)}</span>
        </div>
        {inTable ? null : (
          <div className="flex flex-col">
            <span className="text-phx-3xs font-bold uppercase tracking-[0.12em] text-slate-400">{row.waitingFor ? "You approved" : "Decided"}</span>
            <span className="text-phx-md font-bold text-slate-700">{formatDate(row.decidedAt)}</span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 bg-slate-50/50 px-4 py-3">
        <Link
          className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-slate-300 bg-white px-4 text-phx-sm font-bold text-slate-700 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
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
          <p className="text-phx-2xs font-bold uppercase tracking-[0.14em] text-slate-500">{row.requestCode}</p>
          {/* IT WRAPS. The note here used to read "never truncate with an ellipsis, never wrap to a
              second line" and only the first half is the owner's rule — AGENTS.md §4 says that where
              the no-ellipsis rule meets the no-horizontal-scroll rule, WRAPPING WINS. The measurement
              it quoted is real (459px of pharmacy name in a 317px box) and it is the argument FOR
              wrapping: a name that needs 459px cannot be read in 317px whether it scrolls or not,
              and a sideways scroll on a heading is a gesture nobody makes. The parent is min-w-0,
              so the h3 now takes the second line it needs and the name still arrives whole. */}
          <h3 className="mt-0.5 text-phx-lg font-black tracking-tight text-slate-950">
            {row.requestTitle}
          </h3>
          <p className="mt-0.5 text-phx-xs font-medium text-slate-500">
            Customer: {row.customerName} · {row.requesterRole}
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
  const detailId = `history-detail-${row.id}`;
  // The final word, in one scannable line. It wraps inside its column, so a long approver name
  // takes a second line instead of widening the table.
  const finalResponse = row.waitingFor
    ? `Waiting for ${row.waitingFor.stepName}${row.waitingFor.approverName ? ` · ${row.waitingFor.approverName}` : ""}`
    : row.finalStepName
      ? `${row.finalStepName}${row.finalApproverName ? ` · ${row.finalApproverName}` : ""}`
      : "Not decided on the chain";

  return (
    <>
      <tr
        className="cursor-pointer border-b border-slate-100 transition hover:bg-orange-50/30"
        onClick={onToggle}
      >
        <td className="min-w-0 break-words px-3 py-2.5 text-phx-sm font-bold text-slate-500">{row.requestCode}</td>
        <td className="px-3 py-2.5">
          <span className="block break-words text-phx-md font-black text-slate-950">{row.requestTitle}</span>
          <span className="block break-words text-phx-xs font-medium text-slate-500">Customer: {row.customerName}</span>
        </td>
        <td className="min-w-0 break-words px-3 py-2.5">
          <Badge variant={OUTCOME_VARIANT[row.outcome]}>
            <Icon className="mr-1 h-3 w-3" />
            {row.outcomeLabel}
          </Badge>
        </td>
        <td className="min-w-0 break-words px-3 py-2.5 text-phx-sm font-bold text-slate-700">{finalResponse}</td>
        <td className="min-w-0 break-words px-3 py-2.5 text-phx-md font-black text-slate-950">{egp(row.estimatedCost)}</td>
        <td className="min-w-0 break-words px-3 py-2.5 text-phx-sm font-bold text-slate-700">{formatDate(row.decidedAt)}</td>
        <td className="min-w-0 break-words px-3 py-2.5 text-right">
          <button
            {...rowDetailToggleProps(detailId, isOpen)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-3 text-phx-sm font-bold text-slate-600 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
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
        <TableRowDetail className="p-0" colSpan={DESKTOP_COLUMNS} id={detailId}>
          <HistoryDecisionDetail inTable row={row} />
        </TableRowDetail>
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Skeleton --------------------------------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function HistorySkeleton() {
  return (
    <div className={`animate-pulse space-y-2 rounded-sm border border-slate-200 bg-white p-4 ${adminPanelDepthClassName}`}>
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
      // The waiting label names a stage ("… waiting for Finance"), which differs row to row — the
      // chip groups them all under one plain name.
      const label = row.outcome === "awaiting_next_stage" ? "Waiting for the next stage" : row.outcomeLabel;
      counts.set(row.outcome, { count: (entry?.count ?? 0) + 1, label });
    }
    return Array.from(counts.entries()).map(([outcome, entry]) => ({ ...entry, outcome }));
  }, [rows]);

  // What this history is worth and how it landed, before any of it is read.
  const summary = useMemo(() => {
    let approved = 0;
    let rejected = 0;
    let returned = 0;
    let waiting = 0;
    let value = 0;
    for (const row of rows) {
      if (row.outcome === "approved") approved += 1;
      else if (row.outcome === "rejected") rejected += 1;
      else if (row.outcome === "returned") returned += 1;
      // A request still moving is not decided, so it is neither counted as decided nor valued.
      if (row.outcome === "awaiting_next_stage") {
        waiting += 1;
        continue;
      }
      value += row.estimatedCost ?? 0;
    }
    return { approved, rejected, returned, waiting, value };
  }, [rows]);

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (outcomeFilter !== "all" && row.outcome !== outcomeFilter) return false;
      if (!needle) return true;
      return [row.requestCode, row.requestTitle, row.customerName, row.requesterName, row.requestType, row.finalStepName ?? ""]
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
            <h2 className="text-phx-lg font-black tracking-tight text-slate-950">
              {scope === "company" ? "Every request already decided" : "Requests you took part in"}
            </h2>
            <p className="text-phx-xs font-medium text-slate-400">
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
        <div className="flex items-center gap-2 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-phx-md font-semibold text-amber-900">
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
            value={rows.length - summary.waiting}
          />
          {summary.waiting > 0 ? (
            <PortalMetricCard
              accent="orange"
              icon={Hourglass}
              label="Waiting"
              note="You approved; the next stage has not answered"
              value={summary.waiting}
            />
          ) : null}
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
              className="min-h-10 w-full min-w-0 border-0 bg-transparent text-[16px] font-medium text-slate-800 outline-none placeholder:text-slate-400 sm:text-phx-md"
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
              className={`min-h-9 rounded-sm border px-3 text-phx-sm font-bold transition ${
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
                className={`min-h-9 rounded-sm border px-3 text-phx-sm font-bold transition ${
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
        <div className="rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-phx-sm font-semibold text-amber-900">
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
          <p className="text-phx-base font-black text-slate-800">Nothing has been decided yet</p>
          <p className="max-w-sm text-phx-sm font-medium text-slate-500">
            {scope === "company"
              ? "No marketing request has been approved, rejected or returned so far."
              : "Once a request you raised — or one you are an approver on — is answered, it moves here with the full decision trail."}
          </p>
        </Card>
      ) : visibleRows.length === 0 ? (
        <Card className="rounded-sm border border-slate-200 bg-white px-4 py-8 text-center shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <p className="text-phx-md font-bold text-slate-700">No request matches this filter.</p>
        </Card>
      ) : (
        <Card className="overflow-hidden rounded-sm border border-slate-200 bg-white p-0 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <PortalResponsiveDataList
            empty={
              <p className="px-4 py-8 text-center text-phx-md font-bold text-slate-500">
                No request matches this filter.
              </p>
            }
            getKey={(row) => `history-${row.id}`}
            items={[...pagedRows]}
            renderCard={(row) => <HistoryMobileCard row={row} />}
            renderTable={() => (
              <PortalDesktopTable
                cols={
                  <colgroup>
                    <col className="w-[12%]" />
                    <col className="w-[20%]" />
                    <col className="w-[12%]" />
                    <col className="w-[22%]" />
                    <col className="w-[10%]" />
                    <col className="w-[12%]" />
                    <col className="w-[12%]" />
                  </colgroup>
                }
              >
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    {["Request", "Activity · Requester", "Outcome", "Final response", "Value", "Decided", ""].map(
                      (heading, index) => (
                        <th
                          className="px-3 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500"
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
                className={`min-h-9 rounded-sm border border-slate-200 bg-white px-3 text-phx-sm font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40 disabled:shadow-none ${adminControlDepthClassName}`}
                disabled={safePage === 0}
                onClick={() => setPage(Math.max(0, safePage - 1))}
                type="button"
              >
                Previous
              </button>
              <button
                className={`min-h-9 rounded-sm border border-slate-200 bg-white px-3 text-phx-sm font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40 disabled:shadow-none ${adminControlDepthClassName}`}
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
