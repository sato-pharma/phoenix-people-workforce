import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { getLeaveAttachmentDownloadUrl } from "@/lib/leave/service";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const { id } = await params;
    const result = await getLeaveAttachmentDownloadUrl(access, id);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create leave attachment download URL." }, { status: 404 });
  }
}
