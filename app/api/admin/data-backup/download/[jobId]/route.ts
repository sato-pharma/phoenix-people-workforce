import { NextResponse } from "next/server";

import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { downloadJobResult, getBackgroundJob } from "@/lib/background-jobs/service";
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
    if (job.status !== "completed" || !job.result_bucket || !job.result_path) {
      return NextResponse.json(
        { error: "not_ready", message: `Export is ${job.status}; download not available yet.` },
        { status: 409 },
      );
    }

    const blob = await downloadJobResult(job.result_bucket, job.result_path);
    const buffer = Buffer.from(await blob.arrayBuffer());
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${job.result_filename ?? "data-backup"}"`,
        "content-type": job.result_content_type ?? "application/octet-stream",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden") }, { status: 403 });
    }
    const message = clientSafeErrorMessage(error, "Failed to download export.");
    return NextResponse.json({ error: "server_error", message }, { status: 500 });
  }
}
