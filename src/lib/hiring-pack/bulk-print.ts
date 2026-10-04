// Printing one HR paper for many employees at once — the pieces that are not a screen.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The owner, 2026-10-04: "i want to be able to select and multiple print for many employees example
// print contract or form1 or 6 or any other form for 15 20 maybe 30 employee at once".
//
// THE WORK IS NOT DONE A SECOND WAY. Each employee's paper is fetched from the SAME route a single
// print uses (`/api/hiring-pack/<hrId>/print?format=pdf`), so the permission check, the version the
// employee signed, the field layer, the copy count, the chosen company address, the `*_printed_at`
// stamp and — above all — the paper NUMBER in the register all happen exactly as they do for one
// person. A parallel bulk route would eventually resolve a different version from the one on screen,
// and nothing would say so; this one cannot, because there is no second path.
//
// WHY ONE PDF AND NOT N BROWSER TABS. A browser prints one document per dialog, and thirty dialogs
// each defaulting to single-sided would break the duplex pairing Form 1 and Form 6 depend on. The
// papers come back as PDFs, are joined here in the browser, and are printed ONCE — one dialog, one
// duplex tick, one paper size.
//
// WHICH IS ALSO WHY EVERY EMPLOYEE CAN START ON A FRESH SHEET (`startEachOnNewSheet`). A double-sided
// run lays page 2 on the back of page 1; an odd-paged paper (a three-page contract) would otherwise
// leave its last page sharing a sheet with the next person's first. A blank page after an odd one
// keeps each person's papers separable by hand. Form 1 and Form 6 are even by construction.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { PDFDocument } from "pdf-lib";

/** More than this in one run is a different job: the render is a browser page per person. */
export const BULK_PRINT_MAX_EMPLOYEES = 100;

/** How many papers are rendered at the same time — Chromium is the slow part, and it is shared. */
export const BULK_PRINT_CONCURRENCY = 2;

export type BulkPrintRequest = {
  address: string | null;
  copies: number;
  document: string;
  hrId: string;
  /** Null for a built-in paper; the template row's id for an uploaded one. */
  versionId: string | null;
};

/**
 * The URL of one employee's paper as a PDF.
 *
 * Every parameter is encoded: the document key of a company template is `custom:<uuid>`, and an HR
 * id is whatever the record holds. `marks` is deliberately never sent — absent means NONE, and a
 * stamp or a signature is something a person ticks for ONE print, not something thirty papers
 * inherit (owner, 2026-09-29: "donot put the stamp permanent").
 */
export function bulkPrintUrl(request: BulkPrintRequest): string {
  const params = new URLSearchParams();
  params.set("document", request.document);
  params.set("copies", String(Math.max(1, Math.trunc(request.copies))));
  params.set("format", "pdf");
  if (request.address) params.set("address", request.address);
  if (request.versionId) params.set("version", request.versionId);
  return `/api/hiring-pack/${encodeURIComponent(request.hrId)}/print?${params.toString()}`;
}

/** A name the browser saves the joined file under: ASCII, dated, and never an Arabic document title. */
export function bulkPrintFileName(document: string, employees: number, isoDate: string): string {
  const safe = document.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "papers";
  return `${safe}-${employees}-employees-${isoDate}.pdf`;
}

/** What the screen needs about one person to list them and filter the list. */
export type BulkPrintCandidate = {
  departed: boolean;
  fullName: string;
  hrId: string;
  jobTitle: string | null;
  nameAr: string | null;
};

export type BulkPrintScope = "all" | "current" | "left";

/**
 * The people a search and a scope leave in the list.
 *
 * Case-insensitive, over the HR id, both names and the job title — the four things a person is told
 * apart by. A blank query keeps everyone the scope allows.
 */
export function filterBulkCandidates<T extends BulkPrintCandidate>(
  candidates: readonly T[],
  query: string,
  scope: BulkPrintScope,
): T[] {
  const needle = query.trim().toLowerCase();
  return candidates.filter((candidate) => {
    if (scope === "current" && candidate.departed) return false;
    if (scope === "left" && !candidate.departed) return false;
    if (!needle) return true;
    return [candidate.hrId, candidate.fullName, candidate.nameAr ?? "", candidate.jobTitle ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
}

/** One person's outcome, in the order they were asked for. */
export type BulkPrintOutcome =
  | { bytes: Uint8Array; hrId: string; ok: true }
  | { hrId: string; message: string; ok: false };

/**
 * Run `worker` over `items` with at most `limit` in flight, reporting each completion.
 *
 * Results come back in INPUT order whatever order they finished in — the joined PDF must list people
 * the way they were selected, not the way Chromium happened to finish them. A worker that throws
 * becomes a failed outcome via `onError`, never a rejected run: one person's missing record must not
 * throw away the twenty-nine papers that rendered.
 */
export async function runPool<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  worker: (item: TItem, index: number) => Promise<TResult>,
  onError: (item: TItem, error: unknown) => TResult,
  onDone?: (finished: number, total: number) => void,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let next = 0;
  let finished = 0;

  async function lane() {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = onError(items[index], error);
      }
      finished += 1;
      onDone?.(finished, items.length);
    }
  }

  const lanes = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  return results;
}

/**
 * Join the rendered papers, in order, into one PDF.
 *
 * Page sizes are copied as they are: Form 1 and Form 6 are US Legal, the contract is A4, and a
 * joined run of one paper is one size throughout. `startEachOnNewSheet` appends a blank page the size
 * of the person's last page after any odd-paged paper, so a double-sided print never puts two
 * people's pages on the two faces of one sheet.
 */
export async function joinPdfs(
  parts: readonly Uint8Array[],
  options: { startEachOnNewSheet: boolean },
): Promise<{ bytes: Uint8Array; pages: number }> {
  const joined = await PDFDocument.create();

  for (const part of parts) {
    const source = await PDFDocument.load(part);
    const copied = await joined.copyPages(source, source.getPageIndices());
    for (const page of copied) joined.addPage(page);

    if (options.startEachOnNewSheet && copied.length % 2 === 1) {
      const last = copied[copied.length - 1];
      joined.addPage([last.getWidth(), last.getHeight()]);
    }
  }

  // No default page: an empty run is an empty file, not a file with one blank page nobody asked for.
  const pages = joined.getPageCount();
  return { bytes: await joined.save({ addDefaultPage: false }), pages };
}
