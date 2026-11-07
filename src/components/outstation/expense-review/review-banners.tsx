"use client";

import { AlertTriangle, CheckCircle2, ListChecks } from "lucide-react";

import { AdminCallout } from "@/components/admin/admin-design-system";

import type { SkippedDecision } from "./review-model";

/**
 * What the last Save said. A partial save is neither a success nor a failure and must never wear a
 * green tick: some decisions landed and some did not, and the reviewer has to see which. A save that
 * did not reach payroll (the run's Part 2 already confirmed, or the resync failed — audit finding 47)
 * lists every line the server sent, never a count.
 */
export function ReviewSaveResult({
  saveMessage,
  savePayrollWarnings,
  saveSkipped,
}: {
  saveMessage: string | null;
  savePayrollWarnings: string[];
  saveSkipped: SkippedDecision[];
}) {
  if (!saveMessage) return null;
  const failed = /unable|failed/i.test(saveMessage);
  return (
    <AdminCallout
      tone={
        failed
          ? "danger"
          : saveSkipped.length > 0 || savePayrollWarnings.length > 0
            ? "warning"
            : "success"
      }
    >
      {failed || saveSkipped.length > 0 || savePayrollWarnings.length > 0 ? (
        <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      <div className="min-w-0" data-save-result>
        <p className="break-words text-sm font-semibold">{saveMessage}</p>
        {savePayrollWarnings.length > 0 ? (
          <ul className="mt-1.5 flex flex-col gap-1 text-xs font-medium">
            {savePayrollWarnings.map((line) => (
              <li className="break-words" key={line}>
                {line}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </AdminCallout>
  );
}

/** What the last bulk approval did — and anything it skipped, in so many words. */
export function ReviewBulkResult({ bulkMessage }: { bulkMessage: string | null }) {
  if (!bulkMessage) return null;
  return (
    <AdminCallout tone={/^Nothing/.test(bulkMessage) ? "warning" : "success"}>
      <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="break-words text-sm font-semibold">{bulkMessage}</p>
    </AdminCallout>
  );
}

/**
 * One plain sentence over the list — what is waiting and what can be done in one go — on the orange
 * rail Place checks gives its own advice. Built from the live tiles, so it agrees with them.
 */
export function ReviewAdvice({ advice }: { advice: string }) {
  return (
    <div className="flex min-w-0 items-start gap-3 border border-slate-200 border-l-[3px] border-l-orange-500 bg-white px-4 py-3" data-review-advice>
      <ListChecks aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" />
      <p className="min-w-0 break-words text-sm font-semibold leading-6 text-slate-700">{advice}</p>
    </div>
  );
}
