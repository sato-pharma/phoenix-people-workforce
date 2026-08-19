"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Archive, CalendarDays, CheckCircle2, Eye, History, RefreshCcw, Search, Undo2, XCircle } from "lucide-react";

import {
  ApprovalHistory,
  egp,
  formatDate,
  formatDateTime,
} from "@/components/employee-portal/marketing-approval-chain";
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

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Row card --------------------------------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function HistoryRowCard({ row }: { row: MarketingApproverHistoryRow }) {
  const Icon = OUTCOME_ICON[row.outcome];
  const decidedAt = formatDateTime(row.decidedAt);
  const myDecidedAt = formatDateTime(row.myDecision?.at ?? null);

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

      {/* ------ The response itself: who ended it, when, and in their own words -----------------
          This is the answer the tab is opened for. It sits ABOVE the full chain because the last
          word is what anyone is looking for, and the chain below is the supporting record. */}
      <div className="border-b border-slate-100 px-4 py-3">
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
        <div className="border-b border-slate-100 bg-slate-900/[0.03] px-4 py-2.5">
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
        <div className="border-b border-slate-100 bg-sky-50/60 px-4 py-2 text-[11px] font-semibold text-sky-800">
          You raised this request — this is the answer it came back with.
        </div>
      ) : row.viaOversight ? (
        <div className="border-b border-slate-100 px-4 py-2 text-[11px] font-medium text-slate-400">
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

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/50 px-4 py-3">
        <Link
          className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-slate-300 bg-white px-4 text-[12px] font-bold text-slate-700 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
          href={`/marketing-requests/${row.id}`}
        >
          <Eye className="h-3.5 w-3.5" />
          Open the full record
        </Link>
      </div>
    </Card>
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

/**
 * The inbox's History tab: every marketing request that has already been answered.
 *
 * Loads lazily — this component is only mounted once the tab is actually opened, so the default
 * "In approval" view costs exactly what it did before.
 */
export function MarketingRequestHistory() {
  const [rows, setRows] = useState<MarketingApproverHistoryRow[]>([]);
  const [scope, setScope] = useState<MarketingApproverHistoryWorkspace["scope"]>("mine");
  const [truncated, setTruncated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState<MarketingApproverHistoryOutcome | "all">("all");

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

      {/* ------ Search + outcome filter ------------------------------------------------------------ */}
      {!isLoading && rows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-sm border border-slate-200 bg-white px-3 shadow-sm sm:max-w-xs">
            <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            {/* 16px floor: anything smaller makes iOS Safari zoom the page on focus. */}
            <input
              className="min-h-10 w-full min-w-0 border-0 bg-transparent text-[16px] font-medium text-slate-800 outline-none placeholder:text-slate-400 sm:text-[13px]"
              onChange={(event) => setSearch(event.target.value)}
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
              onClick={() => setOutcomeFilter("all")}
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
                onClick={() => setOutcomeFilter(chip.outcome)}
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
        <div className="space-y-3">
          {visibleRows.map((row) => (
            <HistoryRowCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}
