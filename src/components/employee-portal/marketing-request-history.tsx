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
  XCircle,
} from "lucide-react";

import {
  ApprovalHistory,
  egp,
  formatDate,
  formatDateTime,
} from "@/components/employee-portal/marketing-approval-chain";
import {
  LANDING_INK,
  LandingEmpty,
  LandingMeta,
  LandingTitle,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";
import {
  PortalDesktopTable,
  PortalPagination,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { TableRowDetail, rowDetailToggleProps } from "@/components/ui/table-row-detail";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { cn } from "@/lib/utils";
import type {
  MarketingApproverHistoryOutcome,
  MarketingApproverHistoryRow,
  MarketingApproverHistoryWorkspace,
} from "@/lib/marketing-requests/service";
import { adminChipDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Outcome presentation ------------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

/**
 * The label itself comes from the server (MARKETING_HISTORY_OUTCOME_LABEL) — this is only tone: the
 * outcome's words in its own colour, never a filled pill (the landing kit). Whole literals, so
 * Tailwind ships every one of them.
 */
const OUTCOME_TEXT: Record<MarketingApproverHistoryOutcome, string> = {
  approved: "text-emerald-700",
  archived: "text-slate-500",
  awaiting_next_stage: "text-amber-700",
  cancelled: "text-rose-700",
  closed: "text-slate-500",
  in_flight: "text-amber-700",
  rejected: "text-rose-700",
  returned: "text-amber-700",
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

/** The phone row's left rail, in the outcome's colour — the gradient header it replaced is gone. */
const OUTCOME_RAIL: Record<MarketingApproverHistoryOutcome, string> = {
  approved: "border-l-emerald-500",
  archived: "border-l-slate-300",
  awaiting_next_stage: "border-l-amber-400",
  cancelled: "border-l-rose-500",
  closed: "border-l-slate-300",
  in_flight: "border-l-amber-400",
  rejected: "border-l-rose-500",
  returned: "border-l-amber-500",
};

/** A state in small coloured capitals — the kit's replacement for a filled pill. */
const STATE_TEXT_CLASS = "text-phx-xs font-bold uppercase tracking-[0.08em]";

/** The small-capital label above a figure or a line of the record. */
const FACT_LABEL_CLASS = "text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500";

/** The outcome in coloured capitals with its icon — on the phone row and in the table alike. */
function OutcomeMark({ row }: { row: MarketingApproverHistoryRow }) {
  const Icon = OUTCOME_ICON[row.outcome];
  return (
    <span className={cn("inline-flex items-start gap-1 break-words", STATE_TEXT_CLASS, OUTCOME_TEXT[row.outcome])}>
      <Icon aria-hidden="true" className="mt-px h-3 w-3 shrink-0" />
      <span className="min-w-0">{row.outcomeLabel}</span>
    </span>
  );
}

/**
 * One figure of the strip: a small-capital label, the number in its tone, and the line that says
 * what it counts. Cells sit on hairlines inside the header panel — never a tile on a tile.
 */
function HistoryFigure({
  label,
  note,
  tone = LANDING_INK,
  value,
}: {
  label: string;
  note: string;
  tone?: string;
  value: number | string;
}) {
  return (
    <div className="min-w-0 border-b border-r border-slate-200 bg-white px-3 py-2.5 sm:px-4">
      <p className={cn("break-words", FACT_LABEL_CLASS)}>{label}</p>
      <p className={cn("mt-1 break-words text-[22px] font-bold leading-none tracking-[-0.02em] tabular-nums", tone)}>
        {value}
      </p>
      <p className="mt-1 break-words text-phx-xs font-medium leading-snug text-slate-500">{note}</p>
    </div>
  );
}

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
    <div className="divide-y divide-slate-200">
      {/* ------ The response itself: who ended it, when, and in their own words -----------------
          This is the answer the tab is opened for. It sits ABOVE the full chain because the last
          word is what anyone is looking for, and the chain below is the supporting record. */}
      {/* In the desktop table the row already says the outcome, the final step and approver, and the date;
          the panel keeps only what the row cannot: the decision's own words. */}
      {inTable && !row.waitingFor && row.finalStepName ? (
        <div className="px-4 py-3">
          <p className={FACT_LABEL_CLASS}>Decision comment</p>
          {row.finalDecisionNote ? (
            <p className="mt-1.5 break-words border-l-2 border-slate-300 py-1 pl-2.5 text-phx-sm font-medium leading-snug text-slate-700" dir="auto">
              &ldquo;{row.finalDecisionNote}&rdquo;
            </p>
          ) : (
            <p className="mt-1 text-phx-xs font-medium italic text-slate-500">No comment left with the decision</p>
          )}
        </div>
      ) : inTable && row.waitingFor ? null : (
      <div className="px-4 py-3">
        <p className={FACT_LABEL_CLASS}>
          {row.waitingFor ? "Where it is now" : "Final response"}
        </p>
        {row.waitingFor ? (
          // Not finished, and said so: the request is past this viewer's rung and waiting on the next
          // stage. It is never worded as an approval of the whole request.
          <p className={`mt-1 break-words text-phx-sm font-bold ${LANDING_INK}`}>
            Waiting for {row.waitingFor.stepName}
            {row.waitingFor.approverName ? ` · ${row.waitingFor.approverName}` : ""}
          </p>
        ) : row.finalStepName ? (
          <>
            <p className={`mt-1 break-words text-phx-sm font-bold ${LANDING_INK}`}>
              {row.outcomeLabel} at {row.finalStepName}
              {row.finalApproverName ? ` by ${row.finalApproverName}` : ""}
              {decidedAt ? ` · ${decidedAt}` : ""}
            </p>
            {/* Never truncated. A rejection reason that is cut off is a rejection nobody can act on.
                A left-rail quote, never a tinted box. */}
            {row.finalDecisionNote ? (
              <p className="mt-1.5 break-words border-l-2 border-slate-300 py-1 pl-2.5 text-phx-sm font-medium leading-snug text-slate-700" dir="auto">
                &ldquo;{row.finalDecisionNote}&rdquo;
              </p>
            ) : (
              <p className="mt-1 text-phx-xs font-medium italic text-slate-500">No comment left with the decision</p>
            )}
          </>
        ) : (
          // Not an invented outcome: a request can carry a final status with no decided rung behind
          // it (a legacy import, or a status set outside the chain). Saying so beats guessing.
          <p className={`mt-1 break-words text-phx-sm font-bold ${LANDING_INK}`}>
            {row.outcomeLabel}
            {decidedAt ? ` · ${decidedAt}` : ""} — no decision was recorded on the approval chain.
          </p>
        )}
      </div>
      )}

      {/* ------ What THIS viewer did, when they were part of it — a navy rail, never a tinted band ---- */}
      {row.myDecision ? (
        <div className="flex min-w-0 gap-3 px-4 py-2.5">
          <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-[#08111f]" />
          <div className="min-w-0">
            <p className={FACT_LABEL_CLASS}>Your decision</p>
            <p className={`mt-0.5 break-words text-phx-sm font-bold ${LANDING_INK}`}>
              {row.myDecision.stepName}
              {myDecidedAt ? ` · ${myDecidedAt}` : ""}
            </p>
            {row.myDecision.note ? (
              <p className="mt-1 break-words text-phx-xs font-medium leading-snug text-slate-600" dir="auto">
                &ldquo;{row.myDecision.note}&rdquo;
              </p>
            ) : null}
          </div>
        </div>
      ) : row.isMyRequest ? (
        <div className="flex min-w-0 gap-3 px-4 py-2.5">
          <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-sky-500" />
          <p className="min-w-0 break-words text-phx-xs font-semibold text-slate-700">
            You raised this request — this is the answer it came back with.
          </p>
        </div>
      ) : row.viaOversight ? (
        <div className="px-4 py-2 text-phx-xs font-medium text-slate-500">
          You held no step on this request — shown because you can see the whole company queue.
        </div>
      ) : null}

      <ApprovalHistory requestCode={row.requestCode} rungs={row.approvalHistory} title="Full approval trail" />

      <div className={`grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 ${inTable ? "" : "sm:grid-cols-4"}`}>
        {inTable ? null : (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className={FACT_LABEL_CLASS}>Estimated Cost</span>
            <span className={`break-words text-phx-md font-bold tabular-nums ${LANDING_INK}`}>{egp(row.estimatedCost)}</span>
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className={FACT_LABEL_CLASS}>Pay Date</span>
          <span className={`flex items-center gap-1 break-words text-phx-md font-bold tabular-nums ${LANDING_INK}`}>
            <CalendarDays aria-hidden="true" className="h-3 w-3 shrink-0 text-slate-400" />
            {formatDate(row.payDate)}
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className={FACT_LABEL_CLASS}>Submitted</span>
          <span className={`break-words text-phx-md font-bold tabular-nums ${LANDING_INK}`}>{formatDate(row.submittedAt)}</span>
        </div>
        {inTable ? null : (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className={FACT_LABEL_CLASS}>{row.waitingFor ? "You approved" : "Decided"}</span>
            <span className={`break-words text-phx-md font-bold tabular-nums ${LANDING_INK}`}>{formatDate(row.decidedAt)}</span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Link className={landingActionClassName("outline")} href={`/marketing-requests/${row.id}`}>
          <Eye aria-hidden="true" className="h-3.5 w-3.5" />
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
  // A flat row inside the list's own panel — never a shadowed card on a card — with the outcome
  // carried by its left rail.
  return (
    <article className={`min-w-0 border-b border-l-[3px] border-b-slate-200 bg-white last:border-b-0 ${OUTCOME_RAIL[row.outcome]}`}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <p className="break-words text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">{row.requestCode}</p>
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
          <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500" dir="auto">
            Customer: {row.customerName} · {row.requesterRole}
          </p>
        </div>
        <OutcomeMark row={row} />
      </div>

      <HistoryDecisionDetail row={row} />
    </article>
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
        className={`cursor-pointer border-b border-slate-200 align-top transition-colors hover:bg-slate-50 motion-reduce:transition-none ${isOpen ? "bg-slate-50" : ""}`}
        onClick={onToggle}
      >
        <td className="min-w-0 break-words px-3 py-2.5 text-phx-xs font-bold uppercase tracking-[0.06em] text-slate-500">{row.requestCode}</td>
        <td className="px-3 py-2.5">
          <span className={`block break-words text-phx-md font-bold ${LANDING_INK}`} dir="auto">{row.requestTitle}</span>
          <span className="block break-words text-phx-xs font-medium text-slate-500" dir="auto">Customer: {row.customerName}</span>
        </td>
        <td className="min-w-0 break-words px-3 py-2.5">
          <OutcomeMark row={row} />
        </td>
        <td className="min-w-0 break-words px-3 py-2.5 text-phx-sm font-semibold text-slate-700">{finalResponse}</td>
        <td className={`min-w-0 break-words px-3 py-2.5 text-phx-md font-bold tabular-nums ${LANDING_INK}`}>{egp(row.estimatedCost)}</td>
        <td className="min-w-0 break-words px-3 py-2.5 text-phx-sm font-semibold tabular-nums text-slate-700">{formatDate(row.decidedAt)}</td>
        <td className="min-w-0 break-words px-3 py-2.5 text-right">
          <button
            {...rowDetailToggleProps(detailId, isOpen)}
            className={landingActionClassName("outline", "whitespace-nowrap")}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            type="button"
          >
            <Chevron aria-hidden="true" className="h-3.5 w-3.5" />
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
    <div aria-busy="true" className={`space-y-2 border border-slate-200 bg-white p-4 ${adminSoftDepthClassName}`}>
      <span className="sr-only">Loading</span>
      <div aria-hidden="true" className="employee-portal-skeleton h-3 w-40" />
      <div aria-hidden="true" className="employee-portal-skeleton h-2.5 w-56" />
      <div aria-hidden="true" className="employee-portal-skeleton h-2.5 w-32" />
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
 * Built to the same identity as the live "In approval" tab it sits beside: a figure strip that
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

  const hasRows = !isLoading && rows.length > 0;

  return (
    <div className="space-y-3" dir="auto">
      {/* ------ Header, figures and filters: ONE white panel ---------------------------------------
          The title with its count and Refresh on the right; under it, the figure strip on hairlines
          (a cell only when it has something to count — an empty category padded onto the strip
          reads as a gap in the data rather than as a zero worth showing; owner rule: never pad);
          then search and the outcome filter. */}
      <section className={`@container min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5 sm:px-4">
          <LandingTitle>{scope === "company" ? "Every request already decided" : "Requests you took part in"}</LandingTitle>
          <div className="flex min-w-0 items-center gap-3">
            <LandingMeta
              items={[
                isLoading ? "Loading…" : `${visibleRows.length} of ${rows.length} request${rows.length === 1 ? "" : "s"}`,
              ]}
            />
            <button
              aria-label="Refresh history"
              className={landingActionClassName("outline", "h-auto min-h-10 w-10 bg-white px-0 sm:min-h-10")}
              onClick={() => {
                setIsLoading(true);
                setError(null);
                void loadHistory();
              }}
              title="Refresh history"
              type="button"
            >
              {isLoading ? (
                <LoadingSpinner className="h-3.5 w-3.5 text-current" />
              ) : (
                <RefreshCcw aria-hidden="true" className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </header>

        {hasRows ? (
          <div className="overflow-hidden border-t border-slate-200">
            <div className="-mb-px -mr-px grid grid-cols-2 @2xl:grid-cols-3">
              <HistoryFigure
                label="Decided"
                note="Approved, rejected or returned"
                value={rows.length - summary.waiting}
              />
              {summary.waiting > 0 ? (
                <HistoryFigure
                  label="Waiting"
                  note="You approved; the next stage has not answered"
                  tone="text-amber-700"
                  value={summary.waiting}
                />
              ) : null}
              {summary.approved > 0 ? (
                <HistoryFigure
                  label="Approved"
                  note="Cleared the whole chain"
                  tone="text-emerald-700"
                  value={summary.approved}
                />
              ) : null}
              {summary.returned > 0 ? (
                <HistoryFigure
                  label="Returned"
                  note="Sent back for a change"
                  tone="text-amber-700"
                  value={summary.returned}
                />
              ) : null}
              {summary.rejected > 0 ? (
                <HistoryFigure
                  label="Rejected"
                  note="Turned down on the chain"
                  tone="text-rose-700"
                  value={summary.rejected}
                />
              ) : null}
              {summary.value > 0 ? (
                <HistoryFigure
                  label="Value decided"
                  note="Estimated cost across this history"
                  value={egp(summary.value)}
                />
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ------ Search + outcome filter ---------------------------------------------------------- */}
        {hasRows ? (
          <div className="flex flex-col gap-2 border-t border-slate-200 px-3 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:px-4">
            <label className={`flex min-w-0 flex-1 items-center gap-2 border border-slate-300 bg-white px-3 focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-500/20 sm:max-w-xs ${adminChipDepthClassName}`}>
              <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-slate-400" />
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
                className={landingActionClassName(outcomeFilter === "all" ? "solid" : "outline")}
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
                  className={landingActionClassName(outcomeFilter === chip.outcome ? "solid" : "outline")}
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
      </section>

      {/* ------ Error: a rose rail line, never a tinted box ---------------------------------------- */}
      {error ? (
        <div className={`flex min-w-0 gap-3 border border-slate-200 bg-white px-3 py-2.5 sm:px-4 ${adminSoftDepthClassName}`} role="alert">
          <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-rose-500" />
          <p className="min-w-0 break-words text-phx-sm font-semibold text-rose-800">{error}</p>
        </div>
      ) : null}

      {/* ------ The cap, said out loud rather than hidden — an amber rail line ---------------------- */}
      {truncated ? (
        <div className={`flex min-w-0 gap-3 border border-slate-200 bg-white px-3 py-2.5 sm:px-4 ${adminSoftDepthClassName}`}>
          <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-amber-400" />
          <p className="min-w-0 break-words text-phx-sm font-semibold text-slate-700">
            Showing the most recently decided requests only. Older ones are in the full marketing
            request register.
          </p>
        </div>
      ) : null}

      {/* ------ Body ------------------------------------------------------------------------------ */}
      {isLoading ? (
        <div className="space-y-3">
          <HistorySkeleton />
          <HistorySkeleton />
        </div>
      ) : rows.length === 0 ? (
        <section className={`min-w-0 border border-slate-200 bg-white px-4 py-8 ${adminSoftDepthClassName}`}>
          <p className={`break-words text-phx-base font-bold ${LANDING_INK}`}>Nothing has been decided yet</p>
          <p className="mt-1 max-w-prose break-words text-phx-sm font-medium text-slate-500">
            {scope === "company"
              ? "No marketing request has been approved, rejected or returned so far."
              : "Once a request you raised — or one you are an approver on — is answered, it moves here with the full decision trail."}
          </p>
        </section>
      ) : visibleRows.length === 0 ? (
        <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <LandingEmpty>No request matches this filter.</LandingEmpty>
        </section>
      ) : (
        <section className={`min-w-0 overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <PortalResponsiveDataList
            empty={<LandingEmpty>No request matches this filter.</LandingEmpty>}
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
                  <tr className="border-b border-slate-200">
                    {["Request", "Activity · Requester", "Outcome", "Final response", "Value", "Decided", ""].map(
                      (heading, index) => (
                        <th
                          className="px-3 py-2.5 text-left text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500"
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
                className={landingActionClassName("outline", "disabled:opacity-40")}
                disabled={safePage === 0}
                onClick={() => setPage(Math.max(0, safePage - 1))}
                type="button"
              >
                Previous
              </button>
              <button
                className={landingActionClassName("outline", "disabled:opacity-40")}
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
                type="button"
              >
                Next
              </button>
            </PortalPagination>
          ) : null}
        </section>
      )}
    </div>
  );
}
