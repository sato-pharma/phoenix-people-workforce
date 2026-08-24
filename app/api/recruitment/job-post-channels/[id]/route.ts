import { NextResponse } from "next/server";

import {
  updateJobPostChannel,
  JOB_POST_CHANNEL_KINDS,
  type JobPostChannelKind,
} from "@/lib/recruitment/outreach/job-post-channels";
import {
  assertSameOriginMutation,
  bool,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    const body = await readJsonObject(request);

    // Only keys the caller actually sent are forwarded. An omitted field must leave the stored
    // value alone — sending every key unconditionally is how an edit that renames a group silently
    // blanks its URL.
    const patch: {
      name?: string;
      url?: string | null;
      kind?: JobPostChannelKind;
      notes?: string | null;
      isActive?: boolean;
    } = {};

    if (body.name !== undefined) {
      const name = str(body.name);
      if (!name) {
        return NextResponse.json(
          { error: "validation", message: "A channel needs a name.", success: false },
          { status: 400 },
        );
      }
      patch.name = name;
    }
    if (body.url !== undefined) patch.url = str(body.url);
    if (body.notes !== undefined) patch.notes = str(body.notes);
    if (body.isActive !== undefined) patch.isActive = bool(body.isActive) === true;
    if (body.kind !== undefined) {
      const kind = str(body.kind);
      if (!kind || !(JOB_POST_CHANNEL_KINDS as readonly string[]).includes(kind)) {
        return NextResponse.json(
          { error: "validation", message: "That is not a known channel kind.", success: false },
          { status: 400 },
        );
      }
      patch.kind = kind as JobPostChannelKind;
    }

    const channel = await updateJobPostChannel(id, patch);
    return NextResponse.json({ channel, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to update the advertising channel.");
  }
}
