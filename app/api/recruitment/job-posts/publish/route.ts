import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";
import { writeAuditLog } from "@/lib/admin/audit";
import { assertRealSessionForDecision } from "@/lib/auth/preview-session-guard";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { canPublishJobPosts } from "@/lib/recruitment/access";
import { JobPostTooLongError, renderJobPostPng } from "@/lib/recruitment/job-posts/render";
import { getJobPostTitle, saveJobPostTitleArabic } from "@/lib/recruitment/job-posts/service";
import { JOB_POST_CAREERS, jobPostFileStem, jobPostForArea } from "@/lib/recruitment/job-posts/templates";
import { coerceAreaNoun, coerceAreas, coerceTextEdits, coerceTitleDraft, contentFromDraft, postRequestViolations } from "@/lib/recruitment/job-posts/titles";
import { careersApplyUrl, publishJobCardToWebsite, WebsiteCareersError } from "@/lib/recruitment/job-posts/website";
import { cardTitle, publishCardViolations } from "@/lib/recruitment/job-posts/website-cards";
import { NEW_CHANNEL_APPLY_WHATSAPP_NUMBER } from "@/lib/recruitment/outreach/job-post-channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Publish one job post to the satopharma.com careers page: ONE PRESS, ONE CARD, ONE AREA, the shape the
 * applicant badge expects. `mode: "preview"` only draws the picture for the dialog.
 *
 * SUPER ADMIN ONLY, and only a person's press reaches this (owner: he still presses publish). The picture
 * comes from renderJobPostPng, the same as the download, and a post too long to fit is refused in words.
 *
 * THE ARABIC IS SAVED FIRST, so a refusal from the website never costs the person their typing. It is
 * saved on the title, so a whole-row save from the editor can never wipe it. The press is safe to repeat:
 * the website refuses a second open card with the same exact title.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    if (!canPublishJobPosts(access)) {
      return recruitmentProblem("Publishing to the careers page is open to the Super Admin.", 403);
    }
    assertRealSessionForDecision(access, "publish a job to the careers page");

    const body = await readJsonObject(request);
    const draft = coerceTitleDraft(body.title && typeof body.title === "object" ? (body.title as Record<string, unknown>) : {});
    const areas = coerceAreas(body.areas);
    const areaNoun = coerceAreaNoun(body.areaNoun);
    const edits = coerceTextEdits(body.edits);
    const line = typeof body.line === "string" && body.line.trim() ? body.line.trim() : null;
    const problems = postRequestViolations({ areas, draft, line, template: body.template });
    if (problems.length) return recruitmentProblem(problems.join(" "), 400);
    const template = body.template as Parameters<typeof renderJobPostPng>[1];

    const picked = text(body.area);
    const area = areas.find((name) => name.toLowerCase() === picked.toLowerCase()) ?? null;
    if (areas.length && !area) return recruitmentProblem("Choose which one of this post's areas the card is for.", 400);

    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:job-post:publish" });

    const content = contentFromDraft(draft, { areaNoun, areas, edits, line }, { careers: JOB_POST_CAREERS, whatsapp: NEW_CHANNEL_APPLY_WHATSAPP_NUMBER });
    const one = area ? jobPostForArea(content, area) : content;

    if (body.mode === "preview") {
      const drawn = await renderJobPostPng(one, template);
      return new Response(new Uint8Array(drawn), { headers: { "Cache-Control": "no-store", "Content-Type": "image/png" } });
    }

    const titleId = text(body.titleId);
    const saved = titleId ? await getJobPostTitle(titleId) : null;
    if (!saved || saved.title !== draft.title) return recruitmentProblem("Save the job title first, then publish it.", 409);

    const titleAr = text(body.titleAr);
    const areaAr = text(body.areaAr);
    if (area && !areaAr) return recruitmentProblem("Type the area in Arabic.", 400);
    const descAr = text(body.descAr);
    const card = {
      descAr,
      descEn: text(body.descEn),
      location: text(body.location),
      titleAr: titleAr ? cardTitle(titleAr, area ? areaAr : null) : "",
      titleEn: cardTitle(draft.title, area),
    };
    const violations = publishCardViolations(card);
    if (violations.length) return recruitmentProblem(violations.join(" "), 400);

    const picture = await renderJobPostPng(one, template);
    await saveJobPostTitleArabic(saved.id, { descriptionAr: descAr, titleAr }, access.hrId ?? null);
    const published = await publishJobCardToWebsite(card, picture, `${jobPostFileStem(one, area)}.png`);

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: published.id,
      entityType: "job_post_publish",
      newValues: { action: "publish", area, design: template, location: card.location, slug: published.slug, title: card.titleEn },
      summary: `Published “${card.titleEn}” to the careers page`,
    });

    return Response.json({ applyUrl: careersApplyUrl(published.slug), id: published.id, slug: published.slug, success: true, title: card.titleEn });
  } catch (error) {
    if (error instanceof WebsiteCareersError) return recruitmentProblem(error.message, error.status);
    if (error instanceof JobPostTooLongError) return recruitmentProblem(error.message, 422);
    if (error instanceof ChromiumUnavailableError) {
      return recruitmentProblem("This server cannot draw the post right now. Try again in a minute.", 503);
    }
    return recruitmentApiError(error, "The job post could not be published.");
  }
}
