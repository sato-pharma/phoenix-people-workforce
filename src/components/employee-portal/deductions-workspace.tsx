"use client";

import { useCallback, useMemo, useState } from "react";
import { MessageSquare, Send, ShieldCheck, SlidersHorizontal } from "lucide-react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PictureStrip } from "@/components/deductions/dispute-pictures";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { periodLabel } from "@/lib/business-review/period-format";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import { deductionsCategoryLabel, deductionsUnitLabel } from "@/lib/deductions/calculations.ts";
import {
  PORTAL_LEDGER_ANY,
  PORTAL_LEDGER_OUTCOME_EXPLANATION,
  PORTAL_LEDGER_NO_REPLY_NOTE,
  PORTAL_LEDGER_OUTCOME_LABEL,
  filterPortalLedgerRows,
  portalLedgerCategories,
  portalLedgerMonthKeys,
  portalLedgerStatuses,
  summarizePortalLedger,
} from "@/lib/deductions/portal-ledger-filters.ts";
import type {
  DeductionsCategory,
  DeductionsComment,
  DeductionsPortalLedgerRow,
  DeductionsSalaryRecordsColumn,
  DeductionsUnit,
} from "@/lib/deductions/types";
import { cairoDate, utcDate } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import { phxFieldClassName, phxSelectClassName } from "@/components/ui/form-tokens";

const DEDUCTION_LINES_PAGE_SIZE = 25;

type DeductionsPortalWorkspaceProps = {
  comments: DeductionsComment[];
  rows: DeductionsPortalLedgerRow[];
  ownCompactHrId: string | null;
  /** The first payroll month this screen covers, so the page can name it instead of implying "ever". */
  firstMonthKey: string;
};

function formatMoney(value: number): string {
  return stableCurrencyFormatter("en-EG", {
    currency: "EGP",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-EG", {
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * A deduction date is a calendar day ("2026-08-14"), read in UTC so the day cannot shift; anything
 * carrying a time is a real instant and reads in Cairo. Both come out as "14 Aug 2026".
 */
function formatDeductionDate(value: string): string {
  const text = String(value ?? "").trim();
  const label = /^\d{4}-\d{2}-\d{2}$/.test(text) ? utcDate(text) : cairoDate(text);
  return label === "—" && text ? text : label;
}

/** Days read as "2 Days"; an amount-unit deduction is money, so it reads as EGP like the admin screen. */
function formatDeductionValue(value: number, unit: DeductionsUnit): string {
  return unit === "amount" ? formatMoney(value) : `${formatNumber(value)} ${deductionsUnitLabel(unit)}`;
}

/** "Finger Print" and "Fingerprint", "Unpaid Vacations" and "Unpaid Vacation" are one label. */
function sameLabel(left: string, right: string) {
  const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");
  return key(left) === key(right);
}

function payrollColumnLabel(column: DeductionsSalaryRecordsColumn) {
  if (column === "crm") return "CRM";
  if (column === "finger_print") return "Finger Print";
  if (column === "loans") return "Loan";
  if (column === "other_deductions") return "Other";
  return "Unpaid Vacations";
}

/**
 * Money taken reads as danger, nothing taken as ok, anything still open as warn. A disputed row is
 * info: it is neither settled against him nor cleared.
 */
const OUTCOME_TONE: Record<DeductionsPortalLedgerRow["outcome"], BadgeTone> = {
  on_payslip: "danger",
  cleared: "ok",
  under_review: "warn",
  needs_follow_up: "warn",
  disputed: "info",
};

function groupComments(comments: DeductionsComment[]) {
  const grouped = new Map<string, DeductionsComment[]>();
  for (const comment of comments) {
    const list = grouped.get(comment.candidateId) ?? [];
    list.push(comment);
    grouped.set(comment.candidateId, list);
  }
  return grouped;
}

/** One summary figure, in the same card the screen used before it became a ledger. */
function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="rounded border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      {/* text-xl below sm: at 640–767px a six-digit amount ("EGP 123,456.00") is wider than a
          third of the row in text-2xl, so the figure steps down a size and may wrap rather than
          run past its card. */}
      <p className="mt-2 break-words text-xl font-black text-slate-950 sm:text-2xl">{value}</p>
    </Card>
  );
}

/**
 * The employee's own deductions — EVERY one raised against him from the September 2026 salary
 * onwards, with HR's answer on each (owner, 2026-10-09). It is no longer a list of released
 * publication lines: a row HR has not decided is in here too, saying in words that nothing is
 * deducted until they do.
 *
 * The three filters run in the browser rather than on the server: one person's rows are a handful,
 * they all arrive with the page, and narrowing by month, type or status is then instant.
 */
export function DeductionsPortalWorkspace({
  comments,
  rows,
  ownCompactHrId,
  firstMonthKey,
}: DeductionsPortalWorkspaceProps) {
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [savingCandidateId, setSavingCandidateId] = useState<string | null>(null);
  const [messageByCandidate, setMessageByCandidate] = useState<Record<string, string>>({});
  const [localComments, setLocalComments] = useState<DeductionsComment[]>(comments);
  const commentsByCandidate = useMemo(() => groupComments(localComments), [localComments]);

  const [monthFilter, setMonthFilter] = useState<string>(PORTAL_LEDGER_ANY);
  const [categoryFilter, setCategoryFilter] = useState<string>(PORTAL_LEDGER_ANY);
  const [statusFilter, setStatusFilter] = useState<string>(PORTAL_LEDGER_ANY);

  const monthOptions = useMemo(() => portalLedgerMonthKeys(rows), [rows]);
  const categoryOptions = useMemo(() => portalLedgerCategories(rows), [rows]);
  const statusOptions = useMemo(() => portalLedgerStatuses(rows), [rows]);

  const visibleRows = useMemo(
    () => filterPortalLedgerRows(rows, { category: categoryFilter, monthKey: monthFilter, status: statusFilter }),
    [rows, categoryFilter, monthFilter, statusFilter],
  );
  const totals = useMemo(() => summarizePortalLedger(visibleRows), [visibleRows]);

  const [page, setPage] = useState(0);
  // Any change to the row set OR to a filter puts the reader back on the first page, so a narrowed
  // list can never render empty merely because the old page number is past its end.
  const pageSignature = `${rows.length}|${monthFilter}|${categoryFilter}|${statusFilter}`;
  const [prevSignature, setPrevSignature] = useState(pageSignature);
  if (pageSignature !== prevSignature) {
    setPrevSignature(pageSignature);
    setPage(0);
  }
  const pageRows = visibleRows.slice(page * DEDUCTION_LINES_PAGE_SIZE, (page + 1) * DEDUCTION_LINES_PAGE_SIZE);

  const filtered =
    monthFilter !== PORTAL_LEDGER_ANY || categoryFilter !== PORTAL_LEDGER_ANY || statusFilter !== PORTAL_LEDGER_ANY;

  const submitComment = useCallback(async (candidateId: string) => {
    const body = String(commentDrafts[candidateId] ?? "").trim();
    if (!body) {
      setMessageByCandidate((current) => ({ ...current, [candidateId]: "Write a comment first." }));
      return;
    }
    setSavingCandidateId(candidateId);
    setMessageByCandidate((current) => ({ ...current, [candidateId]: "" }));
    try {
      const response = await fetch("/api/deductions/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, candidateId }),
      });
      const payload = (await response.json()) as {
        comment?: DeductionsComment;
        message?: string;
        success?: boolean;
      };
      if (!response.ok || !payload.success || !payload.comment) {
        setMessageByCandidate((current) => ({
          ...current,
          [candidateId]: payload.message ?? "Comment could not be saved.",
        }));
        return;
      }
      setLocalComments((current) => [payload.comment as DeductionsComment, ...current]);
      setCommentDrafts((current) => ({ ...current, [candidateId]: "" }));
      setMessageByCandidate((current) => ({ ...current, [candidateId]: "Comment saved." }));
    } catch (error) {
      setMessageByCandidate((current) => ({
        ...current,
        [candidateId]: error instanceof Error ? error.message : "Comment could not be saved.",
      }));
    } finally {
      setSavingCandidateId(null);
    }
  }, [commentDrafts]);

  if (rows.length === 0) {
    return (
      <Card className="rounded border border-slate-200 bg-white p-8 text-center shadow-sm">
        <ShieldCheck className="mx-auto h-9 w-9 text-emerald-600" />
        <p className="mt-4 text-lg font-black text-slate-900">No deductions recorded against you</p>
        <p className="mt-2 text-sm text-slate-600">
          This page lists every deduction raised against you from the {periodLabel(firstMonthKey)} salary onwards, and
          what HR decided on each one. There is nothing here yet.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Deducted From Salary" value={formatMoney(totals.deductedAmount)} />
        <SummaryCard label="Deducted Days" value={formatNumber(totals.deductedDays)} />
        <SummaryCard label="Cleared By HR" value={formatNumber(totals.clearedCount)} />
        <SummaryCard label="Still Open" value={formatNumber(totals.openCount)} />
      </div>

      <Card className="rounded border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">
          <SlidersHorizontal className="h-4 w-4" />
          Filter
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block min-w-0">
            <span className="mb-1.5 block text-phx-xs font-bold text-slate-600">Month</span>
            <select
              className={phxSelectClassName}
              onChange={(event) => setMonthFilter(event.target.value)}
              value={monthFilter}
            >
              <option value={PORTAL_LEDGER_ANY}>All months</option>
              {monthOptions.map((month) => (
                <option key={month} value={month}>
                  {periodLabel(month)}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-0">
            <span className="mb-1.5 block text-phx-xs font-bold text-slate-600">Type</span>
            <select
              className={phxSelectClassName}
              onChange={(event) => setCategoryFilter(event.target.value)}
              value={categoryFilter}
            >
              <option value={PORTAL_LEDGER_ANY}>All types</option>
              {categoryOptions.map((category) => (
                <option key={category} value={category}>
                  {deductionsCategoryLabel(category as DeductionsCategory)}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-0">
            <span className="mb-1.5 block text-phx-xs font-bold text-slate-600">Status</span>
            <select
              className={phxSelectClassName}
              onChange={(event) => setStatusFilter(event.target.value)}
              value={statusFilter}
            >
              <option value={PORTAL_LEDGER_ANY}>Any status</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {PORTAL_LEDGER_OUTCOME_LABEL[status]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="text-xs font-semibold text-slate-600">
            Showing {formatNumber(visibleRows.length)} of {formatNumber(rows.length)}
            {rows.length === 1 ? " deduction" : " deductions"}, from the {periodLabel(firstMonthKey)} salary onwards.
          </p>
          {filtered ? (
            <button
              className="whitespace-nowrap border border-slate-300 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-orange-400 hover:text-orange-600"
              onClick={() => {
                setMonthFilter(PORTAL_LEDGER_ANY);
                setCategoryFilter(PORTAL_LEDGER_ANY);
                setStatusFilter(PORTAL_LEDGER_ANY);
              }}
              type="button"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </Card>

      {visibleRows.length === 0 ? (
        <Card className="rounded border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="text-lg font-black text-slate-900">Nothing matches these filters</p>
          <p className="mt-2 text-sm text-slate-600">
            You have {formatNumber(rows.length)} {rows.length === 1 ? "deduction" : "deductions"} in total. Clear the
            filters to see them all.
          </p>
        </Card>
      ) : null}

      <div className="space-y-3">
        {pageRows.map((row) => {
          const ownRow = Boolean(ownCompactHrId && row.employeeHrIdCompact === ownCompactHrId);
          const canComment = ownRow && row.canComment;
          const candidateComments = canComment ? commentsByCandidate.get(row.candidateId) ?? [] : [];
          const message = messageByCandidate[row.candidateId];
          return (
            <Card className="rounded border border-slate-200 bg-white p-4 shadow-sm" key={row.candidateId}>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={OUTCOME_TONE[row.outcome]}>{PORTAL_LEDGER_OUTCOME_LABEL[row.outcome]}</Badge>
                    <Badge tone="neutral">{periodLabel(row.monthKey)}</Badge>
                    {/* The salary column only when it says something the category below does not —
                        "FINGER PRINT" over "Fingerprint" read as the same word twice. */}
                    {sameLabel(payrollColumnLabel(row.payrollColumn), deductionsCategoryLabel(row.category)) ? null : (
                      <Badge tone="neutral">{payrollColumnLabel(row.payrollColumn)}</Badge>
                    )}
                  </div>
                  <p className="mt-2 text-sm font-semibold text-slate-700">{deductionsCategoryLabel(row.category)}</p>
                  <p className="mt-1 text-xs text-slate-600">{PORTAL_LEDGER_OUTCOME_EXPLANATION[row.outcome]}</p>
                  <p className="mt-1 break-words text-xs text-slate-500">
                    Dates: {row.dates.length > 0 ? row.dates.map(formatDeductionDate).join(", ") : "-"}
                  </p>
                  {row.whyFlagged ? (
                    <p className="mt-1 break-words text-xs text-slate-500">Why it was raised: {row.whyFlagged}</p>
                  ) : null}
                </div>
                <div className="grid w-full gap-2 rounded border border-slate-100 bg-slate-50 p-3 text-xs lg:w-[260px] lg:shrink-0">
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-500">Flagged</span>
                    <span className="font-mono font-black text-slate-900">
                      {formatDeductionValue(row.detectedValue, row.unit)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-500">Deducted</span>
                    <span className="font-mono font-black text-slate-900">
                      {formatDeductionValue(row.chargedValue, row.unit)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-500">Amount</span>
                    <span className="font-mono font-black text-slate-900">{formatMoney(row.chargedAmount)}</span>
                  </div>
                  {/* An open row is costing nothing yet, so the estimate is shown apart and greyed —
                      never in the Amount line, which is what actually left the salary. */}
                  {row.outcome !== "on_payslip" && row.outcome !== "cleared" && row.detectedAmount != null && row.detectedAmount > 0 ? (
                    <div className="flex justify-between gap-3 border-t border-slate-200 pt-2">
                      <span className="text-slate-500">If approved</span>
                      <span className="font-mono font-black text-slate-500">{formatMoney(row.detectedAmount)}</span>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* HR's answer on THIS row — the whole point of the page (owner, 2026-10-09). A row
                  nobody has decided says so in words rather than showing an empty block. */}
              <div className="mt-4 border-t border-slate-100 pt-3">
                <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">HR response</p>
                <p className="mt-1.5 text-sm font-semibold text-slate-800">
                  {row.hrStatus === "Pending" ? "Not reviewed yet" : row.hrStatus}
                </p>
                {row.hrResponse ? (
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{row.hrResponse}</p>
                ) : null}
                {row.hrNote ? (
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-600">HR note: {row.hrNote}</p>
                ) : null}
                {row.decidedAt ? (
                  <p className="mt-1 text-phx-xs font-semibold text-slate-400">
                    {row.decidedByName ? `${row.decidedByName} · ` : ""}
                    {cairoDate(row.decidedAt)}
                  </p>
                ) : null}
              </div>

              {canComment ? (
                <div className="mt-4 border-t border-slate-100 pt-4">
                  <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-slate-400">
                    <MessageSquare className="h-4 w-4" />
                    Your response
                  </div>
                  {candidateComments.length > 0 ? (
                    <div className="mt-3 space-y-2">
                      {candidateComments.map((comment) => {
                        // Whose line is this — the employee's own, or HR's reply? A dispute is a
                        // two-way conversation now, so each message says who sent it. HR replies
                        // read in brand orange so they stand apart from the employee's own notes.
                        const fromHr = !(
                          ownCompactHrId &&
                          comment.authorHrId &&
                          compactDeductionsHrId(comment.authorHrId) === ownCompactHrId
                        );
                        return (
                          <div
                            className={cn(
                              "rounded border p-3 text-sm",
                              fromHr ? "border-orange-100 bg-orange-50" : "border-slate-100 bg-slate-50",
                            )}
                            key={comment.id}
                          >
                            <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
                              {fromHr ? `${comment.authorName ?? "HR"} · HR` : "You"}
                            </p>
                            <p className="mt-1 break-words text-slate-700">{comment.body}</p>
                            <PictureStrip attachments={comment.attachments} />
                            <p className="mt-1 text-phx-xs font-semibold text-slate-400">
                              {cairoDate(comment.createdAt)}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <input
                      className={`${phxFieldClassName} flex-1`}
                      maxLength={2000}
                      placeholder="Add a comment for HR"
                      value={commentDrafts[row.candidateId] ?? ""}
                      onChange={(event) =>
                        setCommentDrafts((current) => ({
                          ...current,
                          [row.candidateId]: event.target.value,
                        }))
                      }
                    />
                    <Button
                      className="h-10 gap-2"
                      disabled={savingCandidateId === row.candidateId}
                      type="button"
                      onClick={() => {
                        void submitComment(row.candidateId);
                      }}
                    >
                      {savingCandidateId === row.candidateId ? (
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/70 border-t-transparent" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                      Comment
                    </Button>
                  </div>
                  {message ? (
                    <p
                      className={cn(
                        "mt-2 text-xs font-semibold",
                        message === "Comment saved." ? "text-emerald-600" : "text-rose-600",
                      )}
                    >
                      {message}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-3 text-xs font-semibold text-slate-500">
                  {ownRow ? PORTAL_LEDGER_NO_REPLY_NOTE[row.outcome] : "Manager view is read-only."}
                </p>
              )}
            </Card>
          );
        })}
      </div>

      <PaginationControls
        onPageChange={setPage}
        page={page}
        pageSize={DEDUCTION_LINES_PAGE_SIZE}
        total={visibleRows.length}
      />
    </div>
  );
}
