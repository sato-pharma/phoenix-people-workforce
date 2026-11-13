import { getSupabaseAdmin } from "@/lib/supabase/server";

import { writeRequiredAutomatedPayrollAudit } from "./audit.ts";

/**
 * ONCE FINANCE HAS A BANK FILE, CANCELLING THE RUN IS NO LONGER A QUIET UNDO (F-PAY-016).
 *
 * Cancelling a run says "this month pays nobody": it releases the carry-forward ledger and the run
 * drops out of every file. But a FAB, CIB or finance file already downloaded may already be at the
 * bank. Nothing recorded that a file had left, so a run could be cancelled after its money went
 * out, and the next run for the month would pay the same people again.
 *
 * So every download writes a REQUIRED audit row first — a download that cannot be recorded is not
 * handed out — and cancelling reads those rows and refuses while any exist, unless the person
 * cancelling says, in words, why they are cancelling anyway. The override and its reason are kept
 * on the cancel's own audit row.
 *
 * REOPENING IS THE SAME UNDO (REC-035). Reopening Part 2 unlocks every figure finance was handed, and
 * reopening Part 1 clears the first instalment its bank files paid. Both read the same rows and refuse
 * the same way, with the same override, kept on their own audit rows.
 */

export const BANK_FILE_DOWNLOADED_ACTION = "bank_file_downloaded";

/** The shortest reason accepted for undoing a run after a file left — a word or two is not a reason. */
export const UNDO_AFTER_DOWNLOAD_MIN_REASON = 10;

/** The moves that undo what finance was handed, each refused after a download without a reason. */
export type RunUndoAfterDownload = "cancel" | "reopen_part1" | "reopen_part2";

/**
 * The opening words of every refusal below, as the page receives it (the route strips "Conflict: ").
 * The wizard matches on them to offer the override, so they are pinned by the guard test.
 */
export const DOWNLOAD_REFUSAL_OPENING = "finance has already downloaded";

const UNDO_WORDING: Record<RunUndoAfterDownload, { risk: string; verb: string }> = {
  cancel: { risk: "cancelling would let the month be paid again", verb: "cancel" },
  reopen_part1: {
    risk: "reopening Part 1 would clear the first instalment those files paid, and recompute it",
    verb: "reopen Part 1",
  },
  reopen_part2: {
    risk: "reopening Part 2 would let the figures those files paid be changed",
    verb: "reopen Part 2",
  },
};

export type BankFileKind = "fab" | "cib" | "finance";

export type BankFileDownload = {
  file: BankFileKind;
  scope: string;
  fileName: string;
  actorHrId: string;
  downloadedAt: string;
};

type AuditClient = Pick<ReturnType<typeof getSupabaseAdmin>, "from">;

const FILE_LABEL: Record<BankFileKind, string> = { fab: "FAB bank file", cib: "CIB bank file", finance: "finance sheet" };

/** Record a download. Throws when the row cannot be written, so the caller hands out no file. */
export async function recordBankFileDownloaded(
  input: { runId: string; actorHrId: string; file: BankFileKind; scope: string; fileName: string; rows?: number; role?: string },
  client?: AuditClient,
): Promise<void> {
  try {
    await writeRequiredAutomatedPayrollAudit(
      {
        runId: input.runId,
        actorHrId: input.actorHrId,
        action: BANK_FILE_DOWNLOADED_ACTION,
        // rows and role feed the run's download history (download-log.ts), which reads this row too.
        detail: {
          file: input.file,
          scope: input.scope,
          fileName: input.fileName,
          ...(input.rows === undefined ? {} : { rows: input.rows }),
          ...(input.role === undefined ? {} : { role: input.role }),
        },
      },
      client,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Conflict: the ${FILE_LABEL[input.file]} could not be recorded as downloaded, so it was not handed out — ` +
        `a file nobody recorded could be paid a second time if this run were later cancelled. Try again. (${reason})`,
    );
  }
}

/** Every recorded download for a run, oldest first. Throws on a read failure — never an empty list. */
export async function listBankFileDownloads(runId: string, client?: AuditClient): Promise<BankFileDownload[]> {
  const reader = client ?? getSupabaseAdmin();
  const { data, error } = await reader
    .from("automated_payroll_audit")
    .select("actor_hr_id,detail,created_at")
    .eq("run_id", runId)
    .eq("action", BANK_FILE_DOWNLOADED_ACTION)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(
      "Could not read whether finance has already downloaded this run's bank files, so the run was " +
        `not cancelled, reopened or cleared. Nothing was changed. (${error.message})`,
    );
  }
  return ((data ?? []) as Array<{ actor_hr_id?: unknown; detail?: unknown; created_at?: unknown }>).map((row) => {
    const detail = (row.detail && typeof row.detail === "object" ? row.detail : {}) as Record<string, unknown>;
    const file = detail.file === "cib" || detail.file === "finance" ? detail.file : "fab";
    return {
      file,
      scope: String(detail.scope ?? ""),
      fileName: String(detail.fileName ?? ""),
      actorHrId: String(row.actor_hr_id ?? ""),
      downloadedAt: String(row.created_at ?? ""),
    };
  });
}

function cairoTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** "finance has already downloaded 2 files for this run — FAB bank file (part1), …, the latest on … Cairo time." */
function describeDownloads(downloads: readonly BankFileDownload[]): string {
  const latest = downloads[downloads.length - 1];
  const files = [...new Set(downloads.map((d) => `${FILE_LABEL[d.file]} (${d.scope})`))].join(", ");
  return (
    `${DOWNLOAD_REFUSAL_OPENING} ${downloads.length === 1 ? "a file" : `${downloads.length} files`} ` +
    `for this run — ${files}, the latest on ${cairoTime(latest.downloadedAt)} Cairo time.`
  );
}

/**
 * May this run be cancelled or reopened, given what has been downloaded? Pure.
 *
 * No downloads: yes. Downloads and no override: refused, naming the files. Downloads and an
 * override with a real reason: yes, and the reason is returned to be kept on the move's own row.
 */
export function assertUndoAllowedAfterDownloads(
  downloads: readonly BankFileDownload[],
  override?: { reason?: string | null } | null,
  action: RunUndoAfterDownload = "cancel",
): { overridden: boolean; reason: string | null } {
  if (downloads.length === 0) return { overridden: false, reason: null };
  const reason = (override?.reason ?? "").trim();
  if (override && reason.length >= UNDO_AFTER_DOWNLOAD_MIN_REASON) return { overridden: true, reason };
  const { risk, verb } = UNDO_WORDING[action];
  throw new Error(
    `Conflict: ${describeDownloads(downloads)} That money may already be at the bank, and ${risk}. ` +
      `To ${verb} anyway, send an override with a reason of at least ${UNDO_AFTER_DOWNLOAD_MIN_REASON} characters ` +
      "saying why.",
  );
}

