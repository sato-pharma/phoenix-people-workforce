import type { AccessContext } from "@/lib/auth/permissions";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { assertApiRateLimit } from "@/lib/security/api-rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { writeAutomatedPayrollAudit } from "./audit.ts";
import { BANK_FILE_DOWNLOADED_ACTION } from "./bank-file-downloads.ts";
import { databaseFailureNote } from "./db-error.ts";
import { actorId, assertAutomatedPayrollHrActor } from "./permissions.ts";

/**
 * Every payroll file that leaves the system leaves a row (REC-054, F-PAY-001).
 *
 * The run sheet, the finance sheet and the FAB and CIB bank files carry every employee's pay, and the
 * bank files every account: they are the files the month is executed from. Each download writes one
 * `automated_payroll_audit` row on the run it was built from — who, which file, which part, the file
 * name and how many rows — and the run's own page lists them. The run sheet writes `file_downloaded`
 * here, best-effort like the legacy bank file's (`app/api/payroll/[id]/bank-file/route.ts`). The
 * finance sheet and the FAB and CIB files write ONE row only: the REQUIRED `bank_file_downloaded` of
 * bank-file-downloads.ts (F-PAY-016), which carries the same fields, and the history reads both.
 *
 * A person may take at most PAYROLL_DOWNLOADS_PER_HOUR files an hour, counted across all four. A
 * month needs a handful; the limit stops a script, never finance. Counted BEFORE the file is built, so
 * a refused download builds nothing and leaves no row.
 */
export const PAYROLL_DOWNLOADS_PER_HOUR = 30;

export const PAYROLL_FILE_DOWNLOADED = "file_downloaded";

export type PayrollFileKind = "run_sheet" | "finance_sheet" | "fab_bank_file" | "cib_bank_file";

export async function assertPayrollDownloadAllowed(access: AccessContext): Promise<void> {
  await assertApiRateLimit({
    identifier: actorId(access),
    limit: PAYROLL_DOWNLOADS_PER_HOUR,
    scope: "automated-payroll-download",
    windowMs: 60 * 60_000,
  });
}

/** `client` is a test's fake only — see writeAutomatedPayrollAudit; production passes nothing. */
export async function recordPayrollFileDownload(
  access: AccessContext,
  input: { runId: string; file: PayrollFileKind; scope: string; fileName: string; rows: number },
  client?: Parameters<typeof writeAutomatedPayrollAudit>[1],
): Promise<void> {
  await writeAutomatedPayrollAudit({
    runId: input.runId,
    actorHrId: actorId(access),
    action: PAYROLL_FILE_DOWNLOADED,
    detail: {
      file: input.file,
      scope: input.scope,
      fileName: input.fileName,
      rows: input.rows,
      role: access.role,
    },
  }, client);
}

export type PayrollDownloadEntry = {
  id: string;
  file: PayrollFileKind | string;
  scope: string | null;
  fileName: string | null;
  rows: number | null;
  actorName: string;
  role: string | null;
  downloadedAt: string;
};

/** A bank_file_downloaded row names its file "finance", "fab" or "cib"; the history speaks one vocabulary. */
const BANK_FILE_KIND_NAMES: Record<string, PayrollFileKind> = { cib: "cib_bank_file", fab: "fab_bank_file", finance: "finance_sheet" };

/** The run's download history, newest first — shown on the run itself. Super Admin, like the wizard. */
export async function listRunDownloads(access: AccessContext, runId: string): Promise<PayrollDownloadEntry[]> {
  assertAutomatedPayrollHrActor(access);
  const { data, error } = await getSupabaseAdmin()
    .from("automated_payroll_audit")
    .select("id,actor_hr_id,detail,created_at")
    .eq("run_id", runId)
    .in("action", [PAYROLL_FILE_DOWNLOADED, BANK_FILE_DOWNLOADED_ACTION])
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    throw new Error(
      "Conflict: the download history could not be read. Try again in a moment. " +
        `(${databaseFailureNote(error, "automated_payroll_download_history_read_failed")})`,
    );
  }
  const rows = (data ?? []) as Array<{
    id: string;
    actor_hr_id: string | null;
    detail: Record<string, unknown> | null;
    created_at: string;
  }>;
  const names = await namesByHrId(rows.map((row) => row.actor_hr_id));
  return rows.map((row) => {
    const detail = row.detail ?? {};
    return {
      id: row.id,
      file: typeof detail.file === "string" ? (BANK_FILE_KIND_NAMES[detail.file] ?? detail.file) : "unknown",
      scope: typeof detail.scope === "string" ? detail.scope : null,
      fileName: typeof detail.fileName === "string" ? detail.fileName : null,
      rows: typeof detail.rows === "number" ? detail.rows : null,
      actorName: names.get(row.actor_hr_id) ?? "Unknown person",
      role: typeof detail.role === "string" ? detail.role : null,
      downloadedAt: row.created_at,
    };
  });
}
