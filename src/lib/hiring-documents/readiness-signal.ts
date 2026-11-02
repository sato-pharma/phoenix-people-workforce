// ─────────────────────────────────────────────────────────────────────────────
// Hiring documents: what one employee × document cell is actually saying.
//
// The stored status has three values — submitted, pending, missing — and that is not enough to
// colour a cell honestly, for two reasons the screen already knows about and the export has to
// carry too:
//
//   1. A cell can read "submitted" with ZERO files on file. `types.ts` says why that combination is
//      the one worth looking at: somebody ticked it from memory. Painting it the same green as a
//      scanned, filed document tells the reader it is finished when nothing has been produced.
//   2. A deadline that has passed is a different kind of red from a deadline that has not been set.
//      The dashboard's own `dueDocuments` counter already separates them; a workbook that flattens
//      them back together loses the only thing that says which row to work on first.
//
// So the export classifies into five signals and colours those. Pure, free of React, free of
// ExcelJS and of node:fs, so the screen can adopt the same vocabulary later without moving it.
// ─────────────────────────────────────────────────────────────────────────────

import { hasDepartedEmployment } from "@/lib/auth/session-lifecycle";
import type {
  HiringDocumentDefinition,
  HiringDocumentEmployeeRow,
  HiringDocumentEntry,
} from "@/lib/hiring-documents/types";

/**
 * Does this document apply to this person at all?
 *
 * ONE PREDICATE, asked by the screen, the readiness summary, the completion percentage and the
 * workbook alike. Owner ruling, 2026-09-29: the five exit papers — the two clearances, the
 * resignation request, the mutual termination agreement and Form 6 — only count for leavers.
 *
 * A DOCUMENT THAT DOES NOT APPLY IS NOT "COMPLETE" AND NOT "OUTSTANDING". It is not a slot at all:
 * it leaves the denominator as well as the numerator, which is the only reading under which an
 * active employee who has handed in everything asked of them reads 100%. Counting it as complete
 * would be the tempting shortcut and it is wrong in the other direction — it would report a
 * clearance as filed for somebody who has not left.
 *
 * A LEAVER IS `hasDepartedEmployment`, NOT `!isActive`, and the difference is a real one this repo
 * has already written down: `session-lifecycle.ts` keeps the departed set separate because
 * `inactive`, `historical_payroll_record` and `system_placeholder` are ledger artefacts and payroll
 * placeholders rather than people with a last working day — and, in its own words, a Form 6 filed
 * for a placeholder is a form the insurance office rejects. Asking the shared predicate is also
 * what stops this list drifting from the rest of the system, which cost 46 people once already.
 */
export function hiringDocumentApplies(
  document: Pick<HiringDocumentDefinition, "isExitDocument">,
  employee: Pick<HiringDocumentEmployeeRow, "employmentStatus">,
): boolean {
  if (!document.isExitDocument) return true;
  return hasDepartedEmployment(employee.employmentStatus);
}

/** The documents that apply to one person, in the checklist's own order. */
export function hiringDocumentsFor(
  documents: HiringDocumentDefinition[],
  employee: Pick<HiringDocumentEmployeeRow, "employmentStatus">,
): HiringDocumentDefinition[] {
  return documents.filter((document) => hiringDocumentApplies(document, employee));
}

export type HiringDocumentSignal =
  /** Submitted, and there is at least one scan or upload behind it. */
  | "complete"
  /** Ticked submitted with nothing filed — the tick is somebody's memory, not evidence. */
  | "unevidenced"
  /** Not submitted, and the deadline is today or earlier. */
  | "overdue"
  /** Marked missing by HR, deadline not yet passed (or never set). */
  | "missing"
  /** Nobody has said anything about it yet. */
  | "pending";

export const HIRING_DOCUMENT_SIGNAL_LABEL: Record<HiringDocumentSignal, string> = {
  complete: "Complete",
  missing: "Missing",
  overdue: "Overdue",
  pending: "Pending",
  unevidenced: "Submitted · no file",
};

/**
 * Which signals are the work.
 *
 * 🔴 `unevidenced` IS DELIBERATELY NOT WORK, and this was decided against real production data on
 * 2026-09-29. The whole database holds **3 files against 380 submitted ticks** — scanning is newer
 * than the checklist — so treating a tick with no scan as outstanding put 378 amber cells on the
 * sheet and 479 rows on a chase list whose real content was 101. That is the opposite of what the
 * colour is for: the owner asked to SEE what needs identifying, and a wall of amber identifies
 * nothing.
 *
 * So the matrix colours the question HR actually manages — has this paper arrived — and the
 * evidence gap is carried as a COUNTED column beside it, per employee and per document, where it
 * stays visible and can be acted on without drowning the outstanding work. It is not hidden and it
 * is not lost; it is simply not red.
 */
export function hiringDocumentSignalNeedsAttention(signal: HiringDocumentSignal): boolean {
  return signal === "pending" || signal === "missing" || signal === "overdue";
}

/**
 * How urgent, for sorting the action list. Lower sorts first.
 *
 * 🔴 `unevidenced` RANKS BELOW `pending`, which is not the obvious order. Everything above it is
 * paper nobody has handed in; `unevidenced` is paper that arrived and was merely never scanned —
 * real work, but filing rather than chasing. Ranking it higher would push 377 scanning rows above
 * the 278 that are genuinely outstanding (production, 2026-09-29), and the sheet would stop being
 * workable top to bottom, which is the only instruction it carries.
 */
export const HIRING_DOCUMENT_SIGNAL_RANK: Record<HiringDocumentSignal, number> = {
  complete: 5,
  missing: 2,
  overdue: 1,
  pending: 3,
  unevidenced: 4,
};

/** Midnight today, so a deadline of today counts as due rather than as still to come. */
export function startOfToday(now: Date = new Date()): Date {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return today;
}

function dueDateOf(entry: Pick<HiringDocumentEntry, "dueDate">): Date | null {
  if (!entry.dueDate) return null;
  const due = new Date(`${entry.dueDate}T00:00:00`);
  return Number.isNaN(due.getTime()) ? null : due;
}

/**
 * The signal for one cell.
 *
 * SUBMITTED IS TESTED FIRST, and deliberately before the deadline: a document that arrived after
 * its due date is finished, not late, and marking it red would send HR chasing paper that is
 * already in the file. The deadline only decides anything for a document that has not arrived.
 */
export function hiringDocumentSignal(
  entry: Pick<HiringDocumentEntry, "dueDate" | "fileCount" | "status">,
  today: Date = startOfToday(),
): HiringDocumentSignal {
  if (entry.status === "submitted") {
    return entry.fileCount > 0 ? "complete" : "unevidenced";
  }
  const due = dueDateOf(entry);
  if (due && due <= today) return "overdue";
  return entry.status === "missing" ? "missing" : "pending";
}

/**
 * Whole days a deadline has been past, or null when nothing is late.
 *
 * Null rather than 0 for a document due today: 0 would print in the column as though the deadline
 * had been counted and found to be nothing, which is a different fact from "not late".
 */
export function hiringDocumentDaysOverdue(
  entry: Pick<HiringDocumentEntry, "dueDate" | "fileCount" | "status">,
  today: Date = startOfToday(),
): number | null {
  if (entry.status === "submitted") return null;
  const due = dueDateOf(entry);
  if (!due || due > today) return null;
  const days = Math.round((today.getTime() - due.getTime()) / 86_400_000);
  return days > 0 ? days : null;
}

export type EmployeePapersStanding = {
  /** Handed in and ticked, whether or not a scan is on file. */
  received: number;
  total: number;
  /** Marked missing by HR, deadline not yet passed. */
  missing: number;
  /** Not handed in, and the deadline is today or earlier. */
  overdue: number;
  /** Ticked with nothing on file: filing, not chasing, so it never counts against "received". */
  noScan: number;
};

/** What one employee's row says about their papers, counted from the same signal as the workbook. */
export function employeePapersStanding(
  documents: HiringDocumentDefinition[],
  employee: Pick<HiringDocumentEmployeeRow, "documents" | "employmentStatus">,
  today: Date = startOfToday(),
): EmployeePapersStanding {
  const standing: EmployeePapersStanding = { missing: 0, noScan: 0, overdue: 0, received: 0, total: 0 };
  for (const document of hiringDocumentsFor(documents, employee)) {
    standing.total += 1;
    const signal = hiringDocumentSignal(
      employee.documents[document.id] ?? { dueDate: null, fileCount: 0, status: "pending" },
      today,
    );
    if (signal === "complete" || signal === "unevidenced") standing.received += 1;
    if (signal === "unevidenced") standing.noScan += 1;
    if (signal === "missing") standing.missing += 1;
    if (signal === "overdue") standing.overdue += 1;
  }
  return standing;
}
