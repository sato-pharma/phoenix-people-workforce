// ─────────────────────────────────────────────────────────────────────────────────────────────
// The papers ticked as received with no scan behind them, as one list to work through (owner,
// 2026-11-03). Asks `hiringDocumentSignal`, the same question as the "with no file" figure above the
// screen and the workbook's "Submitted · no file" rows, so the queue's length IS that figure.
//
// Newest hire first, because their paper is the one still on the desk, and one person's papers stay
// together in the checklist's order, because that is how the folder is lying open.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { hiringDocumentSignal, hiringDocumentsFor } from "@/lib/hiring-documents/readiness-signal";
import type { HiringDocumentDefinition, HiringDocumentEmployeeRow } from "@/lib/hiring-documents/types";

export type ScanQueueItem = {
  documentId: string;
  documentName: string;
  employeeHrId: string;
  employeeName: string;
  key: string;
};

export function scanQueueKey(employeeHrId: string, documentId: string): string {
  return `${employeeHrId}|${documentId}`;
}

export function hiringDocumentScanQueue(
  documents: HiringDocumentDefinition[],
  employees: readonly HiringDocumentEmployeeRow[],
): ScanQueueItem[] {
  const newestHireFirst = [...employees].sort(
    (left, right) =>
      (right.hireDate ?? "").localeCompare(left.hireDate ?? "") ||
      left.fullName.localeCompare(right.fullName) ||
      left.hrId.localeCompare(right.hrId),
  );
  return newestHireFirst.flatMap((employee) =>
    hiringDocumentsFor(documents, employee)
      .filter((document) => {
        const entry = employee.documents[document.id];
        return Boolean(entry) && hiringDocumentSignal(entry) === "unevidenced";
      })
      .map((document) => ({
        documentId: document.id,
        documentName: document.name,
        employeeHrId: employee.hrId,
        employeeName: employee.fullName,
        key: scanQueueKey(employee.hrId, document.id),
      })),
  );
}

/** The next paper not yet filed or skipped, or null when the queue has been walked to its end. */
export function nextScanQueueItem(queue: readonly ScanQueueItem[], passed: ReadonlySet<string>): ScanQueueItem | null {
  return queue.find((item) => !passed.has(item.key)) ?? null;
}

/**
 * Where the walk stands. A filed paper leaves the queue when the dashboard re-reads and a skipped one
 * does not, so `passed` holds both and the total is counted from it: "Paper 4 of 372" holds still as
 * the list shrinks. `skipped` is whatever was passed and is still unscanned.
 */
export function scanQueueProgress(
  queue: readonly ScanQueueItem[],
  passed: ReadonlySet<string>,
): { position: number; skipped: number; total: number } {
  const remaining = queue.filter((item) => !passed.has(item.key)).length;
  return {
    position: passed.size + 1,
    skipped: queue.length - remaining,
    total: passed.size + remaining,
  };
}
