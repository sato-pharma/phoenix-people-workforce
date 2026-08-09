import { NextResponse } from "next/server";

import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getBackgroundJob } from "@/lib/background-jobs/service";
import { DATA_BACKUP_EXPORT_JOB } from "@/lib/background-jobs/worker";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthenticated", message: "Not authenticated." }, { status: 401 });
    }
    assertSystemAdministratorWorkspaceAccess(access, "data-backup");

    const { jobId } = await params;
    const job = await getBackgroundJob(jobId);
    if (!job || job.job_type !== DATA_BACKUP_EXPORT_JOB) {
      return NextResponse.json({ error: "not_found", message: "Export job not found." }, { status: 404 });
    }

    return NextResponse.json({
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      ready: job.status === "completed",
      filename: job.result_filename,
      error: job.error,
      createdAt: job.created_at,
      finishedAt: job.finished_at,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden") }, { status: 403 });
    }
    const message = clientSafeErrorMessage(error, "Failed to read job status.");
    return NextResponse.json({ error: "server_error", message }, { status: 500 });
  }
}
