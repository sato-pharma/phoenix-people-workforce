import { NextResponse } from "next/server";

import {
  assertSameOriginMutation,
  bool,
  num,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";
import { resolveCommentAuthor } from "@/lib/recruitment/candidate-comments";
import { loadCandidateSendContext, manualSendAutoValues } from "@/lib/recruitment/whatsapp-templates/candidate-context";
import { createWhatsAppTemplate, listWhatsAppTemplates } from "@/lib/recruitment/whatsapp-templates/store";
import { DEFAULT_TEMPLATE_CATEGORY } from "@/lib/recruitment/whatsapp-templates/template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The WhatsApp message templates, and — when a candidate is named — everything Phoenix can fill in
 * for that person without asking.
 *
 * BOTH IN ONE RESPONSE, deliberately. The send dialog needs the templates and the candidate's number
 * before it can render anything at all; two round trips would show the recruiter an empty box that
 * fills in twice.
 *
 * The gate is `recruitment: update`, not `candidates: read`. Reading a template is one keystroke away
 * from messaging a candidate with it, so the audience for this endpoint is the audience allowed to
 * act on the pipeline — the same grant that sends a CV to a manager or writes a note on a candidate.
 *
 * `includeInactive` is honoured only for a manager view; the send list must never offer a template
 * that was switched off, so it is opt-in rather than the default.
 */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const url = new URL(request.url);
    const candidateId = str(url.searchParams.get("candidateId"));
    const includeInactive = url.searchParams.get("includeInactive") === "true";

    const author = await resolveCommentAuthor(access.hrId).catch(() => ({ jobTitle: null, name: null }));
    const templates = await listWhatsAppTemplates({ includeInactive });

    const candidate = candidateId ? await loadCandidateSendContext(candidateId, author.name) : null;

    return NextResponse.json({
      candidate,
      // The manual path gets the same auto values a candidate would, minus anything person-specific.
      // Handed over even when a candidate WAS named, so the dialog can switch to a typed number
      // without another request.
      manualAutoValues: await manualSendAutoValues(author.name),
      success: true,
      templates,
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the WhatsApp templates.");
  }
}

/**
 * Create a template.
 *
 * `admin: update` — Super Admin only, the same gate as the WhatsApp screening-question wording. The
 * wording of a message that goes to candidates in the company's name is an owner-level decision, and
 * the audience allowed to SEND one is deliberately much wider than the audience allowed to REWRITE
 * what everybody sends.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "admin", "update");

    const payload = await readJsonObject(request);
    const template = await createWhatsAppTemplate(
      {
        body: str(payload.body) ?? "",
        category: str(payload.category) ?? DEFAULT_TEMPLATE_CATEGORY,
        isActive: bool(payload.isActive) ?? true,
        name: str(payload.name) ?? "",
        sortOrder: num(payload.sortOrder) ?? 0,
      },
      access.hrId ?? null,
    );

    return NextResponse.json({ success: true, template });
  } catch (error) {
    return recruitmentApiError(error, "Failed to create the template.");
  }
}
