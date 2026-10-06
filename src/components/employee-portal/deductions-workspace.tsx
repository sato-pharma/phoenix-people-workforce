"use client";

import { useCallback, useMemo, useState } from "react";
import { MessageSquare, Send, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { periodLabel } from "@/lib/business-review/period-format";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import { deductionsCategoryLabel, deductionsUnitLabel } from "@/lib/deductions/calculations.ts";
import type {
  DeductionsComment,
  DeductionsPortalLine,
  DeductionsSalaryRecordsColumn,
  DeductionsUnit,
} from "@/lib/deductions/types";
import { cairoDate, utcDate } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";

const DEDUCTION_LINES_PAGE_SIZE = 25;

type DeductionsPortalWorkspaceProps = {
  comments: DeductionsComment[];
  lines: DeductionsPortalLine[];
  ownCompactHrId: string | null;
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

function payrollColumnLabel(column: DeductionsSalaryRecordsColumn) {
  if (column === "crm") return "CRM";
  if (column === "finger_print") return "Finger Print";
  if (column === "loans") return "Loan";
  if (column === "other_deductions") return "Other";
  return "Unpaid Vacations";
}

function groupComments(comments: DeductionsComment[]) {
  const grouped = new Map<string, DeductionsComment[]>();
  for (const comment of comments) {
    const list = grouped.get(comment.candidateId) ?? [];
    list.push(comment);
    grouped.set(comment.candidateId, list);
  }
  return grouped;
}

export function DeductionsPortalWorkspace({
  comments,
  lines,
  ownCompactHrId,
}: DeductionsPortalWorkspaceProps) {
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [savingCandidateId, setSavingCandidateId] = useState<string | null>(null);
  const [messageByCandidate, setMessageByCandidate] = useState<Record<string, string>>({});
  const [localComments, setLocalComments] = useState<DeductionsComment[]>(comments);
  const commentsByCandidate = useMemo(() => groupComments(localComments), [localComments]);

  const [page, setPage] = useState(0);
  const [prevLines, setPrevLines] = useState(lines);
  if (lines !== prevLines) {
    setPrevLines(lines);
    setPage(0);
  }
  const pageLines = lines.slice(page * DEDUCTION_LINES_PAGE_SIZE, (page + 1) * DEDUCTION_LINES_PAGE_SIZE);

  const totals = useMemo(() => {
    return lines.reduce(
      (sum, line) => ({
        amount: sum.amount + line.appliedAmount,
        count: sum.count + 1,
        days:
          line.deductionUnit === "days"
            ? sum.days + line.appliedDeductionValue
            : sum.days,
      }),
      { amount: 0, count: 0, days: 0 },
    );
  }, [lines]);

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

  if (lines.length === 0) {
    return (
      <Card className="rounded border border-slate-200 bg-white p-8 text-center shadow-sm">
        <ShieldCheck className="mx-auto h-9 w-9 text-emerald-600" />
        <p className="mt-4 text-lg font-black text-slate-900">No published deductions</p>
        <p className="mt-2 text-sm text-slate-600">
          Finalized HR-approved deductions will appear here after monthly finalization.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* text-xl below sm: at 640–767px a six-digit amount ("EGP 123,456.00") is wider than a
          third of the row in text-2xl, so the figure steps down a size and may wrap rather than
          run past its card. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="rounded border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">Deductions</p>
          <p className="mt-2 break-words text-xl font-black text-slate-950 sm:text-2xl">{formatNumber(totals.count)}</p>
        </Card>
        <Card className="rounded border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">Applied Days</p>
          <p className="mt-2 break-words text-xl font-black text-slate-950 sm:text-2xl">{formatNumber(totals.days)}</p>
        </Card>
        <Card className="rounded border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">Applied Amount</p>
          <p className="mt-2 break-words text-xl font-black text-slate-950 sm:text-2xl">{formatMoney(totals.amount)}</p>
        </Card>
      </div>

      <div className="space-y-3">
        {pageLines.map((line) => {
          const canComment = Boolean(ownCompactHrId && line.employeeHrIdCompact === ownCompactHrId);
          const candidateComments = canComment
            ? commentsByCandidate.get(line.candidateId) ?? []
            : [];
          const message = messageByCandidate[line.candidateId];
          return (
            <Card className="rounded border border-slate-200 bg-white p-4 shadow-sm" key={line.id}>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 break-words font-black text-slate-950">{line.employeeName ?? line.employeeCode}</p>
                    <Badge variant="success">{periodLabel(line.monthKey)}</Badge>
                    <Badge variant="warning">{payrollColumnLabel(line.payrollColumn)}</Badge>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-slate-700">
                    {deductionsCategoryLabel(line.deductionType)}
                  </p>
                  <p className="mt-1 break-words text-xs text-slate-500">
                    Dates: {line.dates.length > 0 ? line.dates.map(formatDeductionDate).join(", ") : "-"}
                  </p>
                  {line.hrNote ? (
                    <p className="mt-2 break-words text-xs text-slate-600">HR note: {line.hrNote}</p>
                  ) : null}
                </div>
                <div className="grid w-full gap-2 rounded border border-slate-100 bg-slate-50 p-3 text-xs lg:w-[260px] lg:shrink-0">
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-500">Original flagged</span>
                    <span className="font-mono font-black text-slate-900">
                      {formatDeductionValue(line.originalDeductionValue, line.deductionUnit)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-500">HR applied</span>
                    <span className="font-mono font-black text-slate-900">
                      {formatDeductionValue(line.appliedDeductionValue, line.deductionUnit)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-500">Amount</span>
                    <span className="font-mono font-black text-slate-900">{formatMoney(line.appliedAmount)}</span>
                  </div>
                </div>
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
                      className="h-10 flex-1 rounded border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                      maxLength={2000}
                      placeholder="Add a comment for HR"
                      value={commentDrafts[line.candidateId] ?? ""}
                      onChange={(event) =>
                        setCommentDrafts((current) => ({
                          ...current,
                          [line.candidateId]: event.target.value,
                        }))
                      }
                    />
                    <Button
                      className="h-10 gap-2"
                      disabled={savingCandidateId === line.candidateId}
                      type="button"
                      onClick={() => {
                        void submitComment(line.candidateId);
                      }}
                    >
                      {savingCandidateId === line.candidateId ? (
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
                <p className="mt-4 border-t border-slate-100 pt-3 text-xs font-semibold text-slate-500">
                  Manager view is read-only.
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
        total={lines.length}
      />
    </div>
  );
}
