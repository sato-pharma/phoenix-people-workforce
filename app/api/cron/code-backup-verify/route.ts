import { NextResponse } from "next/server";

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import {
  assessCodeBackup,
  assessDatabaseBackup,
  DB_BACKUP_FOLDER,
  readCodeBackupFiles,
  type CodeBackupVerdict,
} from "@/lib/observability/code-backup-verify";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CODE_JOB_SLUG = "phoenix-code-backup-verify";
const DATABASE_JOB_SLUG = "phoenix-db-backup-verify";

type Checked = CodeBackupVerdict & { read: boolean };

/**
 * One backup's newest file on Drive, judged and reported under its own slug. A Drive that cannot be read is
 * a failed ping for THIS backup only: the other one is still read and reported.
 */
async function checkOne(
  label: string,
  slug: string,
  dryRun: boolean,
  judge: () => Promise<CodeBackupVerdict>,
): Promise<Checked> {
  try {
    const verdict = await judge();
    if (!dryRun) await pingDeadMansSwitch(slug, verdict.outcome, verdict.detail);
    return { ...verdict, read: true };
  } catch (error) {
    logError(`${label} backup check failed`, { error, labels: { event: "cron_failed", job: slug } });
    const detail = `Google Drive could not be read. ${describeThrown(error)}`;
    if (!dryRun) await pingDeadMansSwitch(slug, "fail", detail);
    return { detail, outcome: "fail", read: false };
  }
}

/**
 * Daily: is the newest code backup on Drive recent and the right size, and the newest database backup the
 * same. The verdicts are in src/lib/observability/code-backup-verify.ts. A failed ping is the alarm: the
 * existing sweep carries it, one slug per backup. `?dryRun=1` reads Drive and reports, with no ping.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/code-backup-verify");
  if (denied) return denied;
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  const now = Date.now();
  const code = await checkOne("Code", CODE_JOB_SLUG, dryRun, async () => assessCodeBackup(await readCodeBackupFiles(), now));
  const database = await checkOne("Database", DATABASE_JOB_SLUG, dryRun, async () =>
    assessDatabaseBackup(await readCodeBackupFiles(DB_BACKUP_FOLDER), now),
  );
  const body = {
    ...(dryRun ? { dryRun: true } : {}),
    database: { detail: database.detail, outcome: database.outcome },
    detail: code.detail,
    outcome: code.outcome,
  };
  if (!code.read || !database.read) {
    return NextResponse.json({ ...body, error: "check_failed", success: false }, { status: 500 });
  }
  return NextResponse.json({ ...body, success: true });
}

export async function POST(request: Request) {
  return GET(request);
}
