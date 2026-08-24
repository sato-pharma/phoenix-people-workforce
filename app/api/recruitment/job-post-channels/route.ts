import { NextResponse } from "next/server";

import { resolveApplyDestinations } from "@/lib/recruitment/outreach/apply-destinations";
import { kindFromUrl, parseChannelPasteList } from "@/lib/recruitment/outreach/channel-import";
import {
  createJobPostChannels,
  getChannelAttribution,
  listJobPostChannels,
  JOB_POST_CHANNEL_KINDS,
  type CreateJobPostChannelInput,
  type JobPostChannelKind,
} from "@/lib/recruitment/outreach/job-post-channels";
import {
  assertSameOriginMutation,
  num,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asKind(value: unknown): JobPostChannelKind | null {
  const kind = str(value);
  return kind && (JOB_POST_CHANNEL_KINDS as readonly string[]).includes(kind) ? (kind as JobPostChannelKind) : null;
}

export async function GET(request: Request) {
  try {
    await requireRecruitmentAccess(request, "recruitment", "read");
    const url = new URL(request.url);
    const sinceDays = num(url.searchParams.get("sinceDays")) ?? 90;

    const [channels, attribution] = await Promise.all([
      listJobPostChannels({ includeInactive: true }),
      getChannelAttribution(sinceDays),
    ]);

    return NextResponse.json({
      attribution,
      channels,
      destinations: resolveApplyDestinations(),
      success: true,
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load advertising channels.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "create");
    const body = await readJsonObject(request);

    // Two shapes on purpose: a pasted block straight out of a sidebar or a research table (the
    // fast path, and how the list realistically gets built), or explicit rows when the caller
    // already has structure to hand.
    const inputs: CreateJobPostChannelInput[] = [];
    const paste = str(body.paste);
    if (paste) {
      // The link says which platform it is, so one mixed paste — WhatsApp, Telegram and Facebook
      // together — lands with every row on its own kind. An explicit `kind` in the body is only the
      // fallback for lines that carried no URL to read.
      const fallbackKind = asKind(body.kind) ?? "other";
      for (const line of parseChannelPasteList(paste)) {
        inputs.push({ kind: asKind(line.kind) ?? fallbackKind, name: line.name, url: line.url });
      }
    }

    if (Array.isArray(body.channels)) {
      for (const raw of body.channels) {
        if (!raw || typeof raw !== "object") continue;
        const entry = raw as Record<string, unknown>;
        const name = str(entry.name);
        if (!name) continue;
        inputs.push({
          code: str(entry.code),
          kind: asKind(entry.kind) ?? asKind(kindFromUrl(str(entry.url))) ?? "other",
          name,
          notes: str(entry.notes),
          url: str(entry.url),
        });
      }
    }

    if (inputs.length === 0) {
      return NextResponse.json(
        { error: "validation", message: "Paste at least one group link or name.", success: false },
        { status: 400 },
      );
    }

    const result = await createJobPostChannels(inputs, access);
    return NextResponse.json({ ...result, success: true }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Failed to add advertising channels.");
  }
}
